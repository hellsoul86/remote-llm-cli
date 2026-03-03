package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

const (
	defaultRunRecordsMax    = 500
	defaultRunJobsMax       = 1000
	defaultAuditEventsMax   = 5000
	defaultSessionEventsMax = 20000
	maxRetentionLimit       = 50000
)

type State struct {
	Hosts           []model.Host          `json:"hosts"`
	AccessKeys      []model.AccessKey     `json:"access_keys"`
	RunRecords      []model.RunRecord     `json:"run_records"`
	RunJobs         []model.RunJobRecord  `json:"run_jobs"`
	AuditEvents     []model.AuditEvent    `json:"audit_events"`
	SessionEvents   []model.SessionEvent  `json:"session_events"`
	SessionEventSeq map[string]int64      `json:"session_event_seq"`
	Projects        []model.ProjectRecord `json:"projects"`
	Sessions        []model.SessionRecord `json:"sessions"`
	RetentionPolicy model.RetentionPolicy `json:"retention_policy"`
}

type Store struct {
	mu    sync.RWMutex
	path  string
	state State
}

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("store path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	s := &Store{
		path: path,
		state: State{
			Hosts:           []model.Host{},
			AccessKeys:      []model.AccessKey{},
			RunRecords:      []model.RunRecord{},
			RunJobs:         []model.RunJobRecord{},
			AuditEvents:     []model.AuditEvent{},
			SessionEvents:   []model.SessionEvent{},
			SessionEventSeq: map[string]int64{},
			Projects:        []model.ProjectRecord{},
			Sessions:        []model.SessionRecord{},
			RetentionPolicy: defaultRetentionPolicy(),
		},
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s.saveLocked()
		}
		return fmt.Errorf("read state: %w", err)
	}
	if len(raw) == 0 {
		return nil
	}
	var next State
	if err := json.Unmarshal(raw, &next); err != nil {
		return fmt.Errorf("decode state: %w", err)
	}
	s.state = next
	if s.state.Hosts == nil {
		s.state.Hosts = []model.Host{}
	}
	if s.state.AccessKeys == nil {
		s.state.AccessKeys = []model.AccessKey{}
	}
	if s.state.RunRecords == nil {
		s.state.RunRecords = []model.RunRecord{}
	}
	if s.state.RunJobs == nil {
		s.state.RunJobs = []model.RunJobRecord{}
	}
	if s.state.AuditEvents == nil {
		s.state.AuditEvents = []model.AuditEvent{}
	}
	if s.state.SessionEvents == nil {
		s.state.SessionEvents = []model.SessionEvent{}
	}
	if s.state.SessionEventSeq == nil {
		s.state.SessionEventSeq = map[string]int64{}
	}
	if s.state.Projects == nil {
		s.state.Projects = []model.ProjectRecord{}
	}
	if s.state.Sessions == nil {
		s.state.Sessions = []model.SessionRecord{}
	}
	s.state.RetentionPolicy = normalizeRetentionPolicy(s.state.RetentionPolicy)
	s.state.RunRecords = capTail(s.state.RunRecords, s.state.RetentionPolicy.RunRecordsMax)
	s.state.RunJobs = capTail(s.state.RunJobs, s.state.RetentionPolicy.RunJobsMax)
	s.state.AuditEvents = capTail(s.state.AuditEvents, s.state.RetentionPolicy.AuditEventsMax)
	s.state.SessionEvents = capTail(s.state.SessionEvents, s.state.RetentionPolicy.SessionEventsMax)
	for _, event := range s.state.SessionEvents {
		if event.Seq <= 0 {
			continue
		}
		sessionID := strings.TrimSpace(event.SessionID)
		if sessionID == "" {
			continue
		}
		if event.Seq > s.state.SessionEventSeq[sessionID] {
			s.state.SessionEventSeq[sessionID] = event.Seq
		}
	}
	return nil
}

func (s *Store) saveLocked() error {
	raw, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode state: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("write tmp state: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("swap state file: %w", err)
	}
	return nil
}

func (s *Store) ListHosts() []model.Host {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.Host, len(s.state.Hosts))
	copy(out, s.state.Hosts)
	return out
}

func (s *Store) GetHost(id string) (model.Host, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, h := range s.state.Hosts {
		if h.ID == id {
			return h, true
		}
	}
	return model.Host{}, false
}

func (s *Store) UpsertHost(h model.Host) (model.Host, error) {
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	if h.Port == 0 {
		h.Port = 22
	}
	if h.ID == "" {
		h.ID = fmt.Sprintf("h_%d", now.UnixNano())
		h.CreatedAt = now
		h.UpdatedAt = now
		s.state.Hosts = append(s.state.Hosts, h)
		return h, s.saveLocked()
	}
	for i := range s.state.Hosts {
		if s.state.Hosts[i].ID != h.ID {
			continue
		}
		h.CreatedAt = s.state.Hosts[i].CreatedAt
		h.UpdatedAt = now
		s.state.Hosts[i] = h
		return h, s.saveLocked()
	}
	h.CreatedAt = now
	h.UpdatedAt = now
	s.state.Hosts = append(s.state.Hosts, h)
	return h, s.saveLocked()
}

func (s *Store) DeleteHost(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.Hosts {
		if s.state.Hosts[i].ID != id {
			continue
		}
		s.state.Hosts = append(s.state.Hosts[:i], s.state.Hosts[i+1:]...)
		return true, s.saveLocked()
	}
	return false, nil
}

func (s *Store) UpsertProject(project model.ProjectRecord) (model.ProjectRecord, error) {
	if strings.TrimSpace(project.ID) == "" {
		return model.ProjectRecord{}, errors.New("project id is required")
	}
	now := time.Now().UTC()
	project.ID = strings.TrimSpace(project.ID)
	project.HostID = strings.TrimSpace(project.HostID)
	project.HostName = strings.TrimSpace(project.HostName)
	project.Path = strings.TrimSpace(project.Path)
	project.Runtime = strings.TrimSpace(project.Runtime)
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.Projects {
		if s.state.Projects[i].ID != project.ID {
			continue
		}
		project.CreatedAt = s.state.Projects[i].CreatedAt
		project.UpdatedAt = now
		s.state.Projects[i] = project
		return project, s.saveLocked()
	}
	project.CreatedAt = now
	project.UpdatedAt = now
	s.state.Projects = append(s.state.Projects, project)
	return project, s.saveLocked()
}

func (s *Store) ListProjects(limit int) []model.ProjectRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := copyTail(s.state.Projects, limit)
	return out
}

func (s *Store) UpsertSession(session model.SessionRecord) (model.SessionRecord, error) {
	if strings.TrimSpace(session.ID) == "" {
		return model.SessionRecord{}, errors.New("session id is required")
	}
	now := time.Now().UTC()
	session.ID = strings.TrimSpace(session.ID)
	session.ProjectID = strings.TrimSpace(session.ProjectID)
	session.HostID = strings.TrimSpace(session.HostID)
	session.Path = strings.TrimSpace(session.Path)
	session.Runtime = strings.TrimSpace(session.Runtime)
	session.RuntimeSessionID = strings.TrimSpace(session.RuntimeSessionID)
	session.Title = strings.TrimSpace(session.Title)
	session.LastRunID = strings.TrimSpace(session.LastRunID)
	session.LastStatus = strings.TrimSpace(session.LastStatus)

	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.Sessions {
		if s.state.Sessions[i].ID != session.ID {
			continue
		}
		session.CreatedAt = s.state.Sessions[i].CreatedAt
		session.UpdatedAt = now
		s.state.Sessions[i] = session
		return session, s.saveLocked()
	}
	session.CreatedAt = now
	session.UpdatedAt = now
	s.state.Sessions = append(s.state.Sessions, session)
	return session, s.saveLocked()
}

func (s *Store) GetSession(id string) (model.SessionRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, session := range s.state.Sessions {
		if session.ID == id {
			return session, true
		}
	}
	return model.SessionRecord{}, false
}

func (s *Store) ListSessions(limit int) []model.SessionRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := copyTail(s.state.Sessions, limit)
	return out
}

func (s *Store) ListKeys() []model.AccessKey {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.AccessKey, len(s.state.AccessKeys))
	copy(out, s.state.AccessKeys)
	for i := range out {
		out[i].Hash = ""
	}
	return out
}

func (s *Store) ListKeysUnsafe() []model.AccessKey {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.AccessKey, len(s.state.AccessKeys))
	copy(out, s.state.AccessKeys)
	return out
}

func (s *Store) AddKey(k model.AccessKey) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.AccessKeys = append(s.state.AccessKeys, k)
	return s.saveLocked()
}

func (s *Store) RevokeKey(id string) (bool, error) {
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.AccessKeys {
		if s.state.AccessKeys[i].ID != id {
			continue
		}
		s.state.AccessKeys[i].RevokedAt = &now
		return true, s.saveLocked()
	}
	return false, nil
}

func (s *Store) FindActiveKeyByPrefix(prefix string) (model.AccessKey, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, k := range s.state.AccessKeys {
		if k.Prefix != prefix {
			continue
		}
		if k.RevokedAt != nil {
			continue
		}
		return k, true
	}
	return model.AccessKey{}, false
}

func (s *Store) TouchKey(id string) error {
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.AccessKeys {
		if s.state.AccessKeys[i].ID != id {
			continue
		}
		s.state.AccessKeys[i].LastUsedAt = &now
		return s.saveLocked()
	}
	return nil
}

func (s *Store) AddRunRecord(r model.RunRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.RunRecords = append(s.state.RunRecords, r)
	s.state.RunRecords = capTail(s.state.RunRecords, s.state.RetentionPolicy.RunRecordsMax)
	return s.saveLocked()
}

func (s *Store) AddRunJob(j model.RunJobRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.RunJobs = append(s.state.RunJobs, cloneRunJob(j))
	s.state.RunJobs = capTail(s.state.RunJobs, s.state.RetentionPolicy.RunJobsMax)
	return s.saveLocked()
}

func (s *Store) UpdateRunJob(j model.RunJobRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.RunJobs {
		if s.state.RunJobs[i].ID != j.ID {
			continue
		}
		s.state.RunJobs[i] = cloneRunJob(j)
		return s.saveLocked()
	}
	return fmt.Errorf("run job not found: %s", j.ID)
}

func (s *Store) GetRunJob(id string) (model.RunJobRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, job := range s.state.RunJobs {
		if job.ID == id {
			return cloneRunJob(job), true
		}
	}
	return model.RunJobRecord{}, false
}

func (s *Store) ListRunJobs(limit int) []model.RunJobRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := copyTail(s.state.RunJobs, limit)
	for i := range out {
		out[i] = cloneRunJob(out[i])
	}
	return out
}

func (s *Store) ListRunRecords(limit int) []model.RunRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return copyTail(s.state.RunRecords, limit)
}

func (s *Store) AddAuditEvent(e model.AuditEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.AuditEvents = append(s.state.AuditEvents, e)
	s.state.AuditEvents = capTail(s.state.AuditEvents, s.state.RetentionPolicy.AuditEventsMax)
	return s.saveLocked()
}

func (s *Store) ListAuditEvents(limit int) []model.AuditEvent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return copyTail(s.state.AuditEvents, limit)
}

func (s *Store) AppendSessionEvent(event model.SessionEvent) (model.SessionEvent, error) {
	sessionID := strings.TrimSpace(event.SessionID)
	if sessionID == "" {
		return model.SessionEvent{}, errors.New("session_id is required")
	}
	eventType := strings.TrimSpace(event.Type)
	if eventType == "" {
		return model.SessionEvent{}, errors.New("type is required")
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	event.SessionID = sessionID
	event.Type = eventType
	event.RunID = strings.TrimSpace(event.RunID)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.SessionEventSeq == nil {
		s.state.SessionEventSeq = map[string]int64{}
	}
	nextSeq := s.state.SessionEventSeq[event.SessionID] + 1
	event.Seq = nextSeq
	s.state.SessionEventSeq[event.SessionID] = nextSeq
	s.state.SessionEvents = append(s.state.SessionEvents, cloneSessionEvent(event))
	s.state.SessionEvents = capTail(s.state.SessionEvents, s.state.RetentionPolicy.SessionEventsMax)
	if err := s.saveLocked(); err != nil {
		return model.SessionEvent{}, err
	}
	return cloneSessionEvent(event), nil
}

func (s *Store) ListSessionEvents(sessionID string, after int64, limit int) []model.SessionEvent {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil
	}
	if limit <= 0 {
		limit = 200
	}
	if limit > 2000 {
		limit = 2000
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.SessionEvent, 0, limit)
	for _, event := range s.state.SessionEvents {
		if event.SessionID != sessionID {
			continue
		}
		if event.Seq <= after {
			continue
		}
		out = append(out, cloneSessionEvent(event))
		if len(out) >= limit {
			break
		}
	}
	return out
}

func (s *Store) GetRetentionPolicy() model.RetentionPolicy {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.state.RetentionPolicy
}

func (s *Store) UpdateRetentionPolicy(next model.RetentionPolicy) (model.RetentionPolicy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	normalized := normalizeRetentionPolicy(next)
	s.state.RetentionPolicy = normalized
	s.state.RunRecords = capTail(s.state.RunRecords, normalized.RunRecordsMax)
	s.state.RunJobs = capTail(s.state.RunJobs, normalized.RunJobsMax)
	s.state.AuditEvents = capTail(s.state.AuditEvents, normalized.AuditEventsMax)
	s.state.SessionEvents = capTail(s.state.SessionEvents, normalized.SessionEventsMax)
	return normalized, s.saveLocked()
}

func defaultRetentionPolicy() model.RetentionPolicy {
	return model.RetentionPolicy{
		RunRecordsMax:    defaultRunRecordsMax,
		RunJobsMax:       defaultRunJobsMax,
		AuditEventsMax:   defaultAuditEventsMax,
		SessionEventsMax: defaultSessionEventsMax,
	}
}

func normalizeRetentionPolicy(in model.RetentionPolicy) model.RetentionPolicy {
	out := in
	def := defaultRetentionPolicy()
	out.RunRecordsMax = normalizeRetentionLimit(out.RunRecordsMax, def.RunRecordsMax)
	out.RunJobsMax = normalizeRetentionLimit(out.RunJobsMax, def.RunJobsMax)
	out.AuditEventsMax = normalizeRetentionLimit(out.AuditEventsMax, def.AuditEventsMax)
	out.SessionEventsMax = normalizeRetentionLimit(out.SessionEventsMax, def.SessionEventsMax)
	return out
}

func normalizeRetentionLimit(v int, fallback int) int {
	if v <= 0 {
		v = fallback
	}
	if v < 100 {
		return 100
	}
	if v > maxRetentionLimit {
		return maxRetentionLimit
	}
	return v
}

func copyTail[T any](src []T, limit int) []T {
	if limit <= 0 || limit > len(src) {
		limit = len(src)
	}
	out := make([]T, limit)
	for i := 0; i < limit; i++ {
		out[i] = src[len(src)-1-i]
	}
	return out
}

func capTail[T any](src []T, max int) []T {
	if len(src) <= max {
		return src
	}
	return append([]T(nil), src[len(src)-max:]...)
}

func cloneRunJob(j model.RunJobRecord) model.RunJobRecord {
	out := j
	out.Request = append([]byte(nil), j.Request...)
	out.Response = append([]byte(nil), j.Response...)
	out.HostIDs = append([]string(nil), j.HostIDs...)
	return out
}

func cloneSessionEvent(e model.SessionEvent) model.SessionEvent {
	out := e
	out.Payload = append([]byte(nil), e.Payload...)
	return out
}
