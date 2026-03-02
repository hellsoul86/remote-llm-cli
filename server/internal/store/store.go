package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

type State struct {
	Hosts       []model.Host       `json:"hosts"`
	AccessKeys  []model.AccessKey  `json:"access_keys"`
	RunRecords  []model.RunRecord  `json:"run_records"`
	AuditEvents []model.AuditEvent `json:"audit_events"`
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
	s := &Store{path: path, state: State{Hosts: []model.Host{}, AccessKeys: []model.AccessKey{}}}
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
	if s.state.AuditEvents == nil {
		s.state.AuditEvents = []model.AuditEvent{}
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
	s.state.RunRecords = capTail(s.state.RunRecords, 500)
	return s.saveLocked()
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
	s.state.AuditEvents = capTail(s.state.AuditEvents, 5000)
	return s.saveLocked()
}

func (s *Store) ListAuditEvents(limit int) []model.AuditEvent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return copyTail(s.state.AuditEvents, limit)
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
