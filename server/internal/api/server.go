package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/accesskey"
	"github.com/hellsoul86/remote-llm-cli/server/internal/executor"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
	"github.com/hellsoul86/remote-llm-cli/server/internal/store"
)

type Server struct {
	store          *store.Store
	runtimes       *runtime.Registry
	runJobs        chan string
	runJobWorkers  int
	activeWorkers  int64
	runViaSSH      func(ctx context.Context, h model.Host, spec runtime.CommandSpec, workdir string, opts executor.ExecOptions) (executor.ExecResult, error)
	runRsyncViaSSH func(ctx context.Context, h model.Host, src string, dst string, opts executor.SyncOptions, execOpts executor.ExecOptions) (executor.ExecResult, error)
	mu             sync.Mutex
	cancels        map[string]context.CancelFunc
	cancelRq       map[string]bool
	eventSeq       int64
	eventBuffers   map[string][]runJobEvent
	streamSubID    int64
	streamSubs     map[string]map[int64]chan model.SessionEvent
}

type authIdentity struct {
	KeyID     string
	KeyPrefix string
}

type authContextKey struct{}

const (
	runJobStatusPending   = "pending"
	runJobStatusRunning   = "running"
	runJobStatusSucceeded = "succeeded"
	runJobStatusFailed    = "failed"
	runJobStatusCanceled  = "canceled"
	defaultRunJobWorkers  = 3
	runJobQueueSize       = 512
	jobResultCanceled     = 499
	maxJobEventBacklog    = 1600
	maxChunkEventBytes    = 2048
	sessionStreamBuffer   = 256
	sessionStreamHB       = 12 * time.Second
	sessionStreamBatch    = 1000
)

type runJobEvent struct {
	Seq       int64     `json:"seq"`
	JobID     string    `json:"job_id"`
	Type      string    `json:"type"`
	HostID    string    `json:"host_id,omitempty"`
	HostName  string    `json:"host_name,omitempty"`
	Attempt   int       `json:"attempt,omitempty"`
	Chunk     string    `json:"chunk,omitempty"`
	ExitCode  int       `json:"exit_code,omitempty"`
	Error     string    `json:"error,omitempty"`
	Status    string    `json:"status,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

func New(st *store.Store, rt *runtime.Registry) *Server {
	s := &Server{
		store:          st,
		runtimes:       rt,
		runJobs:        make(chan string, runJobQueueSize),
		cancels:        map[string]context.CancelFunc{},
		cancelRq:       map[string]bool{},
		eventBuffers:   map[string][]runJobEvent{},
		streamSubs:     map[string]map[int64]chan model.SessionEvent{},
		runViaSSH:      executor.RunViaSSH,
		runRsyncViaSSH: executor.RunRsyncViaSSH,
	}
	s.startRunJobWorkers(defaultRunJobWorkers)
	s.recoverRunJobs()
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /v1/healthz", s.handleHealthz)

	mux.Handle("GET /v1/runtimes", s.withAuth(http.HandlerFunc(s.handleListRuntimes)))
	mux.Handle("GET /v1/hosts", s.withAuth(http.HandlerFunc(s.handleListHosts)))
	mux.Handle("POST /v1/hosts", s.withAuth(http.HandlerFunc(s.handleUpsertHost)))
	mux.Handle("DELETE /v1/hosts/{id}", s.withAuth(http.HandlerFunc(s.handleDeleteHost)))
	mux.Handle("POST /v1/hosts/{id}/probe", s.withAuth(http.HandlerFunc(s.handleProbeHost)))
	mux.Handle("POST /v1/run", s.withAuth(http.HandlerFunc(s.handleRun)))
	mux.Handle("POST /v1/jobs/run", s.withAuth(http.HandlerFunc(s.handleEnqueueRunJob)))
	mux.Handle("POST /v1/jobs/sync", s.withAuth(http.HandlerFunc(s.handleEnqueueSyncJob)))
	mux.Handle("GET /v1/projects", s.withAuth(http.HandlerFunc(s.handleListProjects)))
	mux.Handle("POST /v1/projects", s.withAuth(http.HandlerFunc(s.handleUpsertProject)))
	mux.Handle("DELETE /v1/projects/{id}", s.withAuth(http.HandlerFunc(s.handleDeleteProject)))
	mux.Handle("GET /v1/sessions", s.withAuth(http.HandlerFunc(s.handleListSessions)))
	mux.Handle("GET /v1/sessions/{id}", s.withAuth(http.HandlerFunc(s.handleGetSession)))
	mux.Handle("DELETE /v1/sessions/{id}", s.withAuth(http.HandlerFunc(s.handleDeleteSession)))
	mux.Handle("GET /v1/jobs", s.withAuth(http.HandlerFunc(s.handleListRunJobs)))
	mux.Handle("GET /v1/jobs/{id}", s.withAuth(http.HandlerFunc(s.handleGetRunJob)))
	mux.Handle("GET /v1/jobs/{id}/events", s.withAuth(http.HandlerFunc(s.handleListRunJobEvents)))
	mux.Handle("GET /v1/sessions/{id}/events", s.withAuth(http.HandlerFunc(s.handleListSessionEvents)))
	mux.Handle("GET /v1/sessions/{id}/stream", s.withAuth(http.HandlerFunc(s.handleStreamSessionEvents)))
	mux.Handle("POST /v1/jobs/{id}/cancel", s.withAuth(http.HandlerFunc(s.handleCancelRunJob)))
	mux.Handle("POST /v1/sync", s.withAuth(http.HandlerFunc(s.handleSync)))
	mux.Handle("GET /v1/codex/models", s.withAuth(http.HandlerFunc(s.handleDiscoverCodexModels)))
	mux.Handle("POST /v1/codex/sessions/discover", s.withAuth(http.HandlerFunc(s.handleDiscoverCodexSessions)))
	mux.Handle("POST /v1/codex/sessions/cleanup", s.withAuth(http.HandlerFunc(s.handleCleanupCodexSessions)))
	mux.Handle("POST /v1/codex/platform/login", s.withAuth(http.HandlerFunc(s.handleCodexPlatformLogin)))
	mux.Handle("POST /v1/codex/platform/mcp", s.withAuth(http.HandlerFunc(s.handleCodexPlatformMCP)))
	mux.Handle("POST /v1/codex/platform/cloud", s.withAuth(http.HandlerFunc(s.handleCodexPlatformCloud)))
	mux.Handle("POST /v1/files/images", s.withAuth(http.HandlerFunc(s.handleUploadImage)))
	mux.Handle("GET /v1/metrics", s.withAuth(http.HandlerFunc(s.handleMetrics)))
	mux.Handle("GET /v1/admin/retention", s.withAuth(http.HandlerFunc(s.handleGetRetentionPolicy)))
	mux.Handle("POST /v1/admin/retention", s.withAuth(http.HandlerFunc(s.handleSetRetentionPolicy)))
	mux.Handle("GET /v1/runs", s.withAuth(http.HandlerFunc(s.handleListRuns)))
	mux.Handle("GET /v1/audit", s.withAuth(http.HandlerFunc(s.handleListAudit)))

	return s.corsMiddleware(s.requestLogMiddleware(mux))
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w.Header())
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func setCORSHeaders(h http.Header) {
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID")
	h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	h.Set("Access-Control-Max-Age", "86400")
}

func (s *Server) withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r.Header.Get("Authorization"))
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing bearer token"})
			return
		}
		prefix, secret, ok := accesskey.ParseFullKey(token)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid access key format"})
			return
		}
		k, ok := s.store.FindActiveKeyByPrefix(prefix)
		if !ok || !accesskey.VerifySecret(k.Hash, secret) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid access key"})
			return
		}
		_ = s.store.TouchKey(k.ID)
		ctx := context.WithValue(r.Context(), authContextKey{}, authIdentity{KeyID: k.ID, KeyPrefix: k.Prefix})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"service":   "remote-llm-server",
		"timestamp": time.Now().UTC(),
	})
}

func (s *Server) handleListRuntimes(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"runtimes": s.runtimes.List()})
}

func (s *Server) handleListHosts(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"hosts": s.store.ListHosts()})
}

func (s *Server) handleUpsertHost(w http.ResponseWriter, r *http.Request) {
	var h model.Host
	if err := json.NewDecoder(r.Body).Decode(&h); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	if strings.TrimSpace(h.Name) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "name is required"})
		return
	}
	h.Name = strings.TrimSpace(h.Name)
	mode, err := normalizeHostConnectionMode(h.ConnectionMode)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	h.ConnectionMode = mode
	h.Host = strings.TrimSpace(h.Host)
	if h.ConnectionMode == "local" && h.Host == "" {
		h.Host = "localhost"
	}
	if h.ConnectionMode == "ssh" && h.Host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "host is required for ssh mode"})
		return
	}
	h.User = strings.TrimSpace(h.User)
	h.Workspace = strings.TrimSpace(h.Workspace)
	h.IdentityFile = strings.TrimSpace(h.IdentityFile)
	h.SSHProxyJump = strings.TrimSpace(h.SSHProxyJump)
	policy, err := normalizeSSHHostKeyPolicy(h.SSHHostKeyPolicy)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	h.SSHHostKeyPolicy = policy
	if h.ConnectionMode == "ssh" {
		if h.SSHConnectTimeoutSec < 0 || h.SSHConnectTimeoutSec > 300 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ssh_connect_timeout_sec must be in [0,300]"})
			return
		}
		if h.SSHServerAliveIntervalSec < 0 || h.SSHServerAliveIntervalSec > 300 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ssh_server_alive_interval_sec must be in [0,300]"})
			return
		}
		if h.SSHServerAliveCountMax < 0 || h.SSHServerAliveCountMax > 10 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ssh_server_alive_count_max must be in [0,10]"})
			return
		}
	}
	h, err = s.store.UpsertHost(h)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"host": h})
}

func (s *Server) handleDeleteHost(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing host id"})
		return
	}
	deleted, err := s.store.DeleteHost(id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !deleted {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "host not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Server) handleListRuns(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 20, 200)
	writeJSON(w, http.StatusOK, map[string]any{"runs": s.store.ListRunRecords(limit)})
}

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 200, 5000)
	projects := s.store.ListProjects(limit)
	hostIDFilter := strings.TrimSpace(r.URL.Query().Get("host_id"))
	pathFilter := strings.TrimSpace(r.URL.Query().Get("path"))
	runtimeFilter := strings.TrimSpace(r.URL.Query().Get("runtime"))
	filtered := make([]model.ProjectRecord, 0, len(projects))
	for _, project := range projects {
		if hostIDFilter != "" && strings.TrimSpace(project.HostID) != hostIDFilter {
			continue
		}
		if pathFilter != "" && strings.TrimSpace(project.Path) != pathFilter {
			continue
		}
		if runtimeFilter != "" && strings.TrimSpace(project.Runtime) != runtimeFilter {
			continue
		}
		filtered = append(filtered, project)
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": filtered})
}

func (s *Server) handleUpsertProject(w http.ResponseWriter, r *http.Request) {
	var project model.ProjectRecord
	if err := json.NewDecoder(r.Body).Decode(&project); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}

	project.ID = strings.TrimSpace(project.ID)
	project.HostID = strings.TrimSpace(project.HostID)
	project.Path = strings.TrimSpace(project.Path)
	project.Title = strings.TrimSpace(project.Title)
	project.Runtime = strings.TrimSpace(project.Runtime)
	if project.Runtime == "" {
		project.Runtime = "codex"
	}

	if project.ID == "" {
		if project.HostID == "" || project.Path == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "host_id and path are required when project id is missing",
			})
			return
		}
		project.ID = projectBindingID(project.HostID, project.Path)
	}
	if project.HostID == "" || project.Path == "" {
		existing, ok := s.store.GetProject(project.ID)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "host_id and path are required",
			})
			return
		}
		if project.HostID == "" {
			project.HostID = existing.HostID
		}
		if project.Path == "" {
			project.Path = existing.Path
		}
		if project.Runtime == "" {
			project.Runtime = existing.Runtime
		}
	}
	if project.HostID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "host_id is required"})
		return
	}
	if project.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "path is required"})
		return
	}

	host, ok := s.store.GetHost(project.HostID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "host not found"})
		return
	}
	if project.HostName == "" {
		project.HostName = strings.TrimSpace(host.Name)
	}

	saved, err := s.store.UpsertProject(project)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"project": saved})
}

func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	projectID := strings.TrimSpace(r.PathValue("id"))
	if projectID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing project id"})
		return
	}
	project, deleted, sessionRefs, err := s.store.DeleteProject(projectID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !deleted && sessionRefs > 0 {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":         "project is not empty",
			"project":       project,
			"session_count": sessionRefs,
		})
		return
	}
	if !deleted {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "project not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted": true,
		"project": project,
	})
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 200, 5000)
	sessions := s.store.ListSessions(limit)
	projectIDFilter := strings.TrimSpace(r.URL.Query().Get("project_id"))
	hostIDFilter := strings.TrimSpace(r.URL.Query().Get("host_id"))
	pathFilter := strings.TrimSpace(r.URL.Query().Get("path"))
	runtimeFilter := strings.TrimSpace(r.URL.Query().Get("runtime"))
	filtered := make([]model.SessionRecord, 0, len(sessions))
	for _, session := range sessions {
		if projectIDFilter != "" && strings.TrimSpace(session.ProjectID) != projectIDFilter {
			continue
		}
		if hostIDFilter != "" && strings.TrimSpace(session.HostID) != hostIDFilter {
			continue
		}
		if pathFilter != "" && strings.TrimSpace(session.Path) != pathFilter {
			continue
		}
		if runtimeFilter != "" && strings.TrimSpace(session.Runtime) != runtimeFilter {
			continue
		}
		filtered = append(filtered, session)
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": filtered})
}

func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	session, ok := s.store.GetSession(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "session not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": session})
}

func (s *Server) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("id"))
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	session, ok := s.store.GetSession(sessionID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "session not found"})
		return
	}
	sessionRuntime := strings.ToLower(strings.TrimSpace(session.Runtime))
	if sessionRuntime != "" && sessionRuntime != "codex" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":   "remote delete unsupported for session runtime",
			"runtime": session.Runtime,
		})
		return
	}

	hostID := strings.TrimSpace(session.HostID)
	if hostID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "session host_id is missing",
		})
		return
	}
	host, ok := s.store.GetHost(hostID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error":   "session host not found",
			"host_id": hostID,
		})
		return
	}

	spec := buildCodexSessionDeleteSpec(sessionID)
	execRes, runErr := s.runViaSSH(
		r.Context(),
		host,
		spec,
		resolveWorkdir("", host.Workspace),
		executor.ExecOptions{
			MaxStdoutBytes: 512 * 1024,
			MaxStderrBytes: 256 * 1024,
		},
	)
	if runErr != nil {
		msg, class, hint := errorDetails(runErr)
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error":       msg,
			"error_class": class,
			"error_hint":  hint,
			"host":        host,
			"result":      execRes,
		})
		return
	}

	paths := parseCodexSessionDeleteOutput(execRes.Stdout)
	deletedSession, deleted, err := s.store.DeleteSession(sessionID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !deleted {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "session not found"})
		return
	}
	s.closeSessionStreams(sessionID)

	writeJSON(w, http.StatusOK, map[string]any{
		"deleted": true,
		"session": deletedSession,
		"remote": map[string]any{
			"host":       host,
			"result":     execRes,
			"paths":      capStringList(paths, 200),
			"path_count": len(paths),
		},
	})
}

func (s *Server) handleListAudit(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 100, 5000)
	events := s.store.ListAuditEvents(0)
	statusFilter := strings.TrimSpace(r.URL.Query().Get("status"))
	actionFilter := strings.TrimSpace(r.URL.Query().Get("action"))
	methodFilter := strings.TrimSpace(r.URL.Query().Get("method"))
	pathPrefix := strings.TrimSpace(r.URL.Query().Get("path_prefix"))
	fromTime := parseTimeQuery(r.URL.Query().Get("from"))
	toTime := parseTimeQuery(r.URL.Query().Get("to"))
	filtered := make([]model.AuditEvent, 0, len(events))
	for _, evt := range events {
		if statusFilter != "" {
			statusValue, err := strconv.Atoi(statusFilter)
			if err == nil && evt.StatusCode != statusValue {
				continue
			}
		}
		if actionFilter != "" && !strings.EqualFold(strings.TrimSpace(evt.Action), actionFilter) {
			continue
		}
		if methodFilter != "" && !strings.EqualFold(strings.TrimSpace(evt.Method), methodFilter) {
			continue
		}
		if pathPrefix != "" && !strings.HasPrefix(strings.TrimSpace(evt.Path), pathPrefix) {
			continue
		}
		if !fromTime.IsZero() && evt.Timestamp.Before(fromTime) {
			continue
		}
		if !toTime.IsZero() && evt.Timestamp.After(toTime) {
			continue
		}
		filtered = append(filtered, evt)
		if limit > 0 && len(filtered) >= limit {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": filtered})
}

func (s *Server) handleGetRetentionPolicy(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"retention": s.store.GetRetentionPolicy(),
	})
}

func (s *Server) handleSetRetentionPolicy(w http.ResponseWriter, r *http.Request) {
	var req retentionPolicyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	next, err := s.store.UpdateRetentionPolicy(model.RetentionPolicy{
		RunRecordsMax:    req.RunRecordsMax,
		RunJobsMax:       req.RunJobsMax,
		AuditEventsMax:   req.AuditEventsMax,
		SessionEventsMax: req.SessionEventsMax,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"retention": next,
	})
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	jobs := s.store.ListRunJobs(0)
	total := len(jobs)
	succeeded := 0
	failed := 0
	canceled := 0
	running := 0
	pending := 0
	retries := 0
	for _, job := range jobs {
		switch strings.TrimSpace(job.Status) {
		case runJobStatusSucceeded:
			succeeded++
		case runJobStatusFailed:
			failed++
		case runJobStatusCanceled:
			canceled++
		case runJobStatusRunning:
			running++
		case runJobStatusPending:
			pending++
		}
		if len(job.Response) == 0 {
			continue
		}
		var out struct {
			Targets []struct {
				Attempts int `json:"attempts"`
			} `json:"targets"`
		}
		if err := json.Unmarshal(job.Response, &out); err != nil {
			continue
		}
		for _, t := range out.Targets {
			if t.Attempts > 1 {
				retries += t.Attempts - 1
			}
		}
	}
	terminal := succeeded + failed + canceled
	successRate := 0.0
	if terminal > 0 {
		successRate = float64(succeeded) / float64(terminal)
	}
	workersTotal := s.runJobWorkers
	workersActive := int(atomic.LoadInt64(&s.activeWorkers))
	utilization := 0.0
	if workersTotal > 0 {
		utilization = float64(workersActive) / float64(workersTotal)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"jobs": map[string]any{
			"total":          total,
			"pending":        pending,
			"running":        running,
			"succeeded":      succeeded,
			"failed":         failed,
			"canceled":       canceled,
			"retry_attempts": retries,
		},
		"queue": map[string]any{
			"depth":              len(s.runJobs),
			"workers_total":      workersTotal,
			"workers_active":     workersActive,
			"worker_utilization": utilization,
		},
		"success_rate": successRate,
	})
}

type runRequest struct {
	HostID         string                   `json:"host_id,omitempty"`
	HostIDs        []string                 `json:"host_ids,omitempty"`
	AllHosts       bool                     `json:"all_hosts,omitempty"`
	Fanout         int                      `json:"fanout,omitempty"`
	SessionID      string                   `json:"session_id,omitempty"`
	Runtime        string                   `json:"runtime"`
	Prompt         string                   `json:"prompt"`
	Workdir        string                   `json:"workdir,omitempty"`
	ExtraArgs      []string                 `json:"extra_args,omitempty"`
	TimeoutSec     int                      `json:"timeout_sec,omitempty"`
	MaxOutputKB    int                      `json:"max_output_kb,omitempty"`
	RetryCount     int                      `json:"retry_count,omitempty"`
	RetryBackoffMS int                      `json:"retry_backoff_ms,omitempty"`
	Codex          *runtime.CodexRunOptions `json:"codex,omitempty"`
}

type runResponseSummary struct {
	Total          int       `json:"total"`
	Succeeded      int       `json:"succeeded"`
	Failed         int       `json:"failed"`
	Fanout         int       `json:"fanout"`
	RetryCount     int       `json:"retry_count"`
	RetryBackoffMS int64     `json:"retry_backoff_ms"`
	DurationMS     int64     `json:"duration_ms"`
	StartedAt      time.Time `json:"started_at"`
	FinishedAt     time.Time `json:"finished_at"`
}

type runResponse struct {
	Runtime string             `json:"runtime"`
	Summary runResponseSummary `json:"summary"`
	Targets []runTargetResult  `json:"targets"`
}

type syncRequest struct {
	HostID         string   `json:"host_id,omitempty"`
	HostIDs        []string `json:"host_ids,omitempty"`
	AllHosts       bool     `json:"all_hosts,omitempty"`
	Fanout         int      `json:"fanout,omitempty"`
	TimeoutSec     int      `json:"timeout_sec,omitempty"`
	MaxOutputKB    int      `json:"max_output_kb,omitempty"`
	RetryCount     int      `json:"retry_count,omitempty"`
	RetryBackoffMS int      `json:"retry_backoff_ms,omitempty"`

	Src      string   `json:"src"`
	Dst      string   `json:"dst"`
	Delete   bool     `json:"delete,omitempty"`
	Excludes []string `json:"excludes,omitempty"`
}

type syncResponse struct {
	Operation string             `json:"operation"`
	Runtime   string             `json:"runtime"`
	Summary   runResponseSummary `json:"summary"`
	Targets   []runTargetResult  `json:"targets"`
}

type codexSessionsRequest struct {
	HostID       string   `json:"host_id,omitempty"`
	HostIDs      []string `json:"host_ids,omitempty"`
	AllHosts     bool     `json:"all_hosts,omitempty"`
	Fanout       int      `json:"fanout,omitempty"`
	TimeoutSec   int      `json:"timeout_sec,omitempty"`
	LimitPerHost int      `json:"limit_per_host,omitempty"`
}

type codexCleanupRequest struct {
	HostID         string   `json:"host_id,omitempty"`
	HostIDs        []string `json:"host_ids,omitempty"`
	AllHosts       bool     `json:"all_hosts,omitempty"`
	Fanout         int      `json:"fanout,omitempty"`
	TimeoutSec     int      `json:"timeout_sec,omitempty"`
	OlderThanHours int      `json:"older_than_hours,omitempty"`
	DryRun         bool     `json:"dry_run,omitempty"`
}

type codexPlatformLoginRequest struct {
	HostID     string `json:"host_id,omitempty"`
	Action     string `json:"action,omitempty"`
	TimeoutSec int    `json:"timeout_sec,omitempty"`
}

type codexPlatformMCPRequest struct {
	HostID            string   `json:"host_id,omitempty"`
	Action            string   `json:"action,omitempty"`
	Name              string   `json:"name,omitempty"`
	URL               string   `json:"url,omitempty"`
	Command           []string `json:"command,omitempty"`
	Env               []string `json:"env,omitempty"`
	BearerTokenEnvVar string   `json:"bearer_token_env_var,omitempty"`
	Scopes            []string `json:"scopes,omitempty"`
	TimeoutSec        int      `json:"timeout_sec,omitempty"`
}

type codexPlatformCloudRequest struct {
	HostID     string `json:"host_id,omitempty"`
	Action     string `json:"action,omitempty"`
	TaskID     string `json:"task_id,omitempty"`
	EnvID      string `json:"env_id,omitempty"`
	Query      string `json:"query,omitempty"`
	Attempts   int    `json:"attempts,omitempty"`
	Branch     string `json:"branch,omitempty"`
	Limit      int    `json:"limit,omitempty"`
	Cursor     string `json:"cursor,omitempty"`
	Attempt    int    `json:"attempt,omitempty"`
	TimeoutSec int    `json:"timeout_sec,omitempty"`
}

type codexPlatformResult struct {
	Operation  string              `json:"operation"`
	Host       model.Host          `json:"host"`
	Command    []string            `json:"command"`
	Workdir    string              `json:"workdir,omitempty"`
	OK         bool                `json:"ok"`
	Error      string              `json:"error,omitempty"`
	ErrorClass string              `json:"error_class,omitempty"`
	ErrorHint  string              `json:"error_hint,omitempty"`
	Result     executor.ExecResult `json:"result"`
	JSON       any                 `json:"json,omitempty"`
}

type codexModelsResponse struct {
	Host         model.Host `json:"host"`
	DefaultModel string     `json:"default_model"`
	Models       []string   `json:"models"`
	Warning      string     `json:"warning,omitempty"`
}

type retentionPolicyRequest struct {
	RunRecordsMax    int `json:"run_records_max,omitempty"`
	RunJobsMax       int `json:"run_jobs_max,omitempty"`
	AuditEventsMax   int `json:"audit_events_max,omitempty"`
	SessionEventsMax int `json:"session_events_max,omitempty"`
}

type codexSessionInfo struct {
	SessionID  string    `json:"session_id"`
	Path       string    `json:"path"`
	Cwd        string    `json:"cwd,omitempty"`
	ThreadName string    `json:"thread_name,omitempty"`
	UpdatedAt  time.Time `json:"updated_at"`
	SizeBytes  int64     `json:"size_bytes"`
}

type codexSessionTarget struct {
	Host       model.Host          `json:"host"`
	Result     executor.ExecResult `json:"result"`
	OK         bool                `json:"ok"`
	Error      string              `json:"error,omitempty"`
	ErrorClass string              `json:"error_class,omitempty"`
	ErrorHint  string              `json:"error_hint,omitempty"`
	Sessions   []codexSessionInfo  `json:"sessions,omitempty"`
}

type codexCleanupTarget struct {
	Host       model.Host          `json:"host"`
	Result     executor.ExecResult `json:"result"`
	OK         bool                `json:"ok"`
	Error      string              `json:"error,omitempty"`
	ErrorClass string              `json:"error_class,omitempty"`
	ErrorHint  string              `json:"error_hint,omitempty"`
	DryRun     bool                `json:"dry_run"`
	PathCount  int                 `json:"path_count"`
	Paths      []string            `json:"paths,omitempty"`
	Deleted    int                 `json:"deleted"`
	Candidates int                 `json:"candidates"`
}

type preparedRun struct {
	Request runRequest
	Hosts   []model.Host
	Spec    runtime.CommandSpec
}

type preparedSync struct {
	Request syncRequest
	Hosts   []model.Host
}

type runProgressObserver struct {
	OnAttempt func(host model.Host, attempt int)
	OnStdout  func(host model.Host, attempt int, chunk string)
	OnStderr  func(host model.Host, attempt int, chunk string)
	OnResult  func(target runTargetResult)
}

type apiError struct {
	StatusCode int
	Message    string
}

func (e apiError) Error() string {
	return e.Message
}

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	var req runRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	identity, _ := authIdentityFromContext(r.Context())
	status, resp, err := s.executeRunRequest(r.Context(), req, identity)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, status, resp)
}

func (s *Server) handleEnqueueRunJob(w http.ResponseWriter, r *http.Request) {
	var req runRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	prepared, err := s.prepareRun(req)
	if err != nil {
		writeError(w, err)
		return
	}
	rawReq, err := json.Marshal(req)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "encode run request failed"})
		return
	}
	now := time.Now().UTC()
	fanout := normalizeFanout(prepared.Request.Fanout, len(prepared.Hosts))
	identity, _ := authIdentityFromContext(r.Context())
	jobID := fmt.Sprintf("job_%d", now.UnixNano())
	job := model.RunJobRecord{
		ID:             jobID,
		Type:           "run",
		Status:         runJobStatusPending,
		Runtime:        prepared.Request.Runtime,
		PromptPreview:  promptPreview(prepared.Request.Prompt),
		SessionID:      normalizeSessionID(prepared.Request.SessionID, jobID),
		HostIDs:        collectHostIDs(prepared.Hosts),
		CreatedByKeyID: identity.KeyID,
		QueuedAt:       now,
		TotalHosts:     len(prepared.Hosts),
		Fanout:         fanout,
		Request:        rawReq,
	}
	titleUpdated, titleValue, err := s.ensureSessionBinding(job, prepared.Request, prepared.Hosts)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if err := s.store.AddRunJob(job); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	s.appendRunJobEventForJob(job, runJobEvent{Type: "job.queued", Status: runJobStatusPending})
	if titleUpdated {
		s.appendSessionStructuredEvent(job, "session.title.updated", map[string]any{
			"title": titleValue,
		})
	}
	if s.enqueueStoredJob(job.ID) {
		writeJSON(w, http.StatusAccepted, map[string]any{"job": compactRunJob(job)})
		return
	}
	finished := time.Now().UTC()
	job.Status = runJobStatusFailed
	job.ResultStatus = http.StatusServiceUnavailable
	job.Error = "job queue is full"
	job.FinishedAt = &finished
	_ = s.store.UpdateRunJob(job)
	_ = s.updateSessionRunState(job)
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": job.Error, "job": compactRunJob(job)})
}

func (s *Server) handleEnqueueSyncJob(w http.ResponseWriter, r *http.Request) {
	var req syncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	prepared, err := s.prepareSync(req)
	if err != nil {
		writeError(w, err)
		return
	}
	rawReq, err := json.Marshal(req)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "encode sync request failed"})
		return
	}
	now := time.Now().UTC()
	identity, _ := authIdentityFromContext(r.Context())
	jobID := fmt.Sprintf("job_%d", now.UnixNano())
	job := model.RunJobRecord{
		ID:             jobID,
		Type:           "sync",
		Status:         runJobStatusPending,
		Runtime:        "sync",
		PromptPreview:  syncPreview(req.Src, req.Dst),
		SessionID:      normalizeSessionID("", jobID),
		HostIDs:        collectHostIDs(prepared.Hosts),
		CreatedByKeyID: identity.KeyID,
		QueuedAt:       now,
		TotalHosts:     len(prepared.Hosts),
		Fanout:         normalizeFanout(prepared.Request.Fanout, len(prepared.Hosts)),
		Request:        rawReq,
	}
	if err := s.store.AddRunJob(job); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	s.appendRunJobEventForJob(job, runJobEvent{Type: "job.queued", Status: runJobStatusPending})
	if s.enqueueStoredJob(job.ID) {
		writeJSON(w, http.StatusAccepted, map[string]any{"job": compactRunJob(job)})
		return
	}
	finished := time.Now().UTC()
	job.Status = runJobStatusFailed
	job.ResultStatus = http.StatusServiceUnavailable
	job.Error = "job queue is full"
	job.FinishedAt = &finished
	_ = s.store.UpdateRunJob(job)
	_ = s.updateSessionRunState(job)
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": job.Error, "job": compactRunJob(job)})
}

func (s *Server) handleListRunJobs(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 30, 5000)
	jobs := s.store.ListRunJobs(0)
	statusFilter := splitQueryCSV(r.URL.Query().Get("status"))
	typeFilter := splitQueryCSV(r.URL.Query().Get("type"))
	runtimeFilter := splitQueryCSV(r.URL.Query().Get("runtime"))
	hostIDFilter := strings.TrimSpace(r.URL.Query().Get("host_id"))
	fromTime := parseTimeQuery(r.URL.Query().Get("from"))
	toTime := parseTimeQuery(r.URL.Query().Get("to"))
	filtered := make([]model.RunJobRecord, 0, len(jobs))
	for _, job := range jobs {
		if len(statusFilter) > 0 && !setContains(statusFilter, strings.ToLower(strings.TrimSpace(job.Status))) {
			continue
		}
		if len(typeFilter) > 0 && !setContains(typeFilter, strings.ToLower(strings.TrimSpace(job.Type))) {
			continue
		}
		if len(runtimeFilter) > 0 && !setContains(runtimeFilter, strings.ToLower(strings.TrimSpace(job.Runtime))) {
			continue
		}
		if hostIDFilter != "" && !jobMatchesHost(job, hostIDFilter) {
			continue
		}
		if !fromTime.IsZero() && job.QueuedAt.Before(fromTime) {
			continue
		}
		if !toTime.IsZero() && job.QueuedAt.After(toTime) {
			continue
		}
		filtered = append(filtered, compactRunJob(job))
		if limit > 0 && len(filtered) >= limit {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": filtered})
}

func (s *Server) handleGetRunJob(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing job id"})
		return
	}
	job, ok := s.store.GetRunJob(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "job not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": job})
}

func (s *Server) handleListRunJobEvents(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing job id"})
		return
	}
	if _, ok := s.store.GetRunJob(id); !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "job not found"})
		return
	}
	after := int64(0)
	if raw := strings.TrimSpace(r.URL.Query().Get("after")); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid after"})
			return
		}
		after = v
	}
	limit := parseLimit(r, 200, 1000)
	events, next := s.listRunJobEvents(id, after, limit)
	writeJSON(w, http.StatusOK, map[string]any{
		"job_id":     id,
		"after":      after,
		"next_after": next,
		"events":     events,
	})
}

func (s *Server) handleListSessionEvents(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("id"))
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	after := int64(0)
	if raw := strings.TrimSpace(r.URL.Query().Get("after")); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid after"})
			return
		}
		after = v
	}
	limit := parseLimit(r, 200, 2000)
	events := s.store.ListSessionEvents(sessionID, after, limit)
	next := after
	for _, event := range events {
		if event.Seq > next {
			next = event.Seq
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_id":  sessionID,
		"after":       after,
		"next_after":  next,
		"event_count": len(events),
		"events":      events,
	})
}

func (s *Server) handleStreamSessionEvents(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("id"))
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	after := int64(0)
	if raw := strings.TrimSpace(r.URL.Query().Get("after")); raw != "" {
		v, err := parseCursor(raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid after"})
			return
		}
		after = v
	}
	if raw := strings.TrimSpace(r.Header.Get("Last-Event-ID")); raw != "" {
		if v, err := parseCursor(raw); err == nil && v > after {
			after = v
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "streaming not supported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	streamCh, unsubscribe := s.subscribeSessionStream(sessionID, sessionStreamBuffer)
	defer unsubscribe()

	lastSeq := after
	for {
		events := s.store.ListSessionEvents(sessionID, lastSeq, sessionStreamBatch)
		if len(events) == 0 {
			break
		}
		for _, event := range events {
			if event.Seq <= lastSeq {
				continue
			}
			if err := writeSSEEvent(w, flusher, "session.event", strconv.FormatInt(event.Seq, 10), event); err != nil {
				return
			}
			lastSeq = event.Seq
		}
		if len(events) < sessionStreamBatch {
			break
		}
	}

	if err := writeSSEEvent(w, flusher, "session.ready", "", map[string]any{
		"session_id": sessionID,
		"cursor":     lastSeq,
	}); err != nil {
		return
	}

	ticker := time.NewTicker(sessionStreamHB)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case event, ok := <-streamCh:
			if !ok {
				_ = writeSSEEvent(w, flusher, "session.reset", "", map[string]any{
					"reason":     "backpressure",
					"next_after": lastSeq,
				})
				return
			}
			if event.Seq <= lastSeq {
				continue
			}
			if err := writeSSEEvent(w, flusher, "session.event", strconv.FormatInt(event.Seq, 10), event); err != nil {
				return
			}
			lastSeq = event.Seq
		case now := <-ticker.C:
			if err := writeSSEEvent(w, flusher, "heartbeat", "", map[string]any{
				"session_id": sessionID,
				"cursor":     lastSeq,
				"timestamp":  now.UTC(),
			}); err != nil {
				return
			}
		}
	}
}

func parseCursor(raw string) (int64, error) {
	v, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || v < 0 {
		return 0, errors.New("invalid cursor")
	}
	return v, nil
}

func writeSSEEvent(w io.Writer, flusher http.Flusher, eventType string, eventID string, payload any) error {
	if eventID != "" {
		if _, err := fmt.Fprintf(w, "id: %s\n", eventID); err != nil {
			return err
		}
	}
	if strings.TrimSpace(eventType) != "" {
		if _, err := fmt.Fprintf(w, "event: %s\n", strings.TrimSpace(eventType)); err != nil {
			return err
		}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if _, err := fmt.Fprintf(w, "data: %s\n", line); err != nil {
			return err
		}
	}
	if _, err := io.WriteString(w, "\n"); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func (s *Server) handleCancelRunJob(w http.ResponseWriter, r *http.Request) {
	jobID := strings.TrimSpace(r.PathValue("id"))
	if jobID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing job id"})
		return
	}
	job, ok := s.store.GetRunJob(jobID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "job not found"})
		return
	}
	switch job.Status {
	case runJobStatusSucceeded, runJobStatusFailed, runJobStatusCanceled:
		writeJSON(w, http.StatusConflict, map[string]any{"error": "job already finished", "job": compactRunJob(job)})
		return
	case runJobStatusPending:
		finished := time.Now().UTC()
		job.Status = runJobStatusCanceled
		job.ResultStatus = jobResultCanceled
		job.Error = "canceled before execution"
		job.FinishedAt = &finished
		if err := s.store.UpdateRunJob(job); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		_ = s.updateSessionRunState(job)
		s.appendRunJobEventForJob(job, runJobEvent{Type: "job.canceled", Status: runJobStatusCanceled, Error: job.Error})
		writeJSON(w, http.StatusOK, map[string]any{"state": "canceled", "job": compactRunJob(job)})
		return
	case runJobStatusRunning:
		s.requestJobCancel(jobID)
		s.appendRunJobEventForJob(job, runJobEvent{Type: "job.cancel_requested", Status: runJobStatusRunning})
		writeJSON(w, http.StatusAccepted, map[string]any{
			"state": "cancel_requested",
			"job":   compactRunJob(job),
		})
		return
	default:
		writeJSON(w, http.StatusConflict, map[string]any{"error": "job cannot be canceled in current state", "job": compactRunJob(job)})
		return
	}
}

func (s *Server) executeRunRequest(parentCtx context.Context, req runRequest, identity authIdentity) (int, runResponse, error) {
	prepared, err := s.prepareRun(req)
	if err != nil {
		return 0, runResponse{}, err
	}
	status, resp := s.executePreparedRun(parentCtx, prepared, identity, nil)
	return status, resp, nil
}

func (s *Server) prepareRun(req runRequest) (preparedRun, error) {
	hosts, err := s.resolveHosts(req.HostID, req.HostIDs, req.AllHosts)
	if err != nil {
		return preparedRun{}, apiError{StatusCode: http.StatusBadRequest, Message: err.Error()}
	}
	if err := runtime.ValidateRuntime(req.Runtime); err != nil {
		return preparedRun{}, apiError{StatusCode: http.StatusBadRequest, Message: err.Error()}
	}
	adapter, ok := s.runtimes.Get(req.Runtime)
	if !ok {
		return preparedRun{}, apiError{StatusCode: http.StatusBadRequest, Message: "unsupported runtime"}
	}
	spec, err := adapter.BuildRunCommand(runtime.RunRequest{
		Prompt:    req.Prompt,
		Workdir:   req.Workdir,
		ExtraArgs: req.ExtraArgs,
		Codex:     req.Codex,
	})
	if err != nil {
		return preparedRun{}, apiError{StatusCode: http.StatusBadRequest, Message: err.Error()}
	}
	return preparedRun{
		Request: req,
		Hosts:   hosts,
		Spec:    spec,
	}, nil
}

func (s *Server) executePreparedRun(
	parentCtx context.Context,
	prepared preparedRun,
	identity authIdentity,
	observer *runProgressObserver,
) (int, runResponse) {
	req := prepared.Request
	timeout := 600 * time.Second
	if req.TimeoutSec > 0 {
		timeout = time.Duration(req.TimeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(parentCtx, timeout)
	defer cancel()

	startedAt := time.Now().UTC()
	fanout := normalizeFanout(req.Fanout, len(prepared.Hosts))
	retryCount, retryBackoff := resolveRetryPolicy(req.RetryCount, req.RetryBackoffMS)
	maxOutputBytes := resolveMaxOutputBytes(req.MaxOutputKB)
	targets := s.runFanout(ctx, prepared.Hosts, fanout, func(host model.Host) runTargetResult {
		res, runErr, attempts := executeWithRetry(ctx, retryCount, retryBackoff, func(attempt int) (executor.ExecResult, error) {
			if observer != nil && observer.OnAttempt != nil {
				observer.OnAttempt(host, attempt)
			}
			return s.runViaSSH(
				ctx,
				host,
				prepared.Spec,
				resolveWorkdir(req.Workdir, host.Workspace),
				executor.ExecOptions{
					MaxStdoutBytes: maxOutputBytes,
					MaxStderrBytes: maxOutputBytes,
					OnStdoutChunk: func(raw []byte) {
						if observer == nil || observer.OnStdout == nil {
							return
						}
						observer.OnStdout(host, attempt, truncateChunkBytes(raw))
					},
					OnStderrChunk: func(raw []byte) {
						if observer == nil || observer.OnStderr == nil {
							return
						}
						observer.OnStderr(host, attempt, truncateChunkBytes(raw))
					},
				},
			)
		})
		msg, class, hint := errorDetails(runErr)
		item := runTargetResult{
			Host:       host,
			Result:     res,
			OK:         runErr == nil,
			Error:      msg,
			ErrorClass: class,
			ErrorHint:  hint,
			Attempts:   attempts,
		}
		if observer != nil && observer.OnResult != nil {
			observer.OnResult(item)
		}
		return item
	})
	if req.Runtime == "codex" && req.Codex != nil && req.Codex.JSONOutput {
		annotateCodexJSONSummary(targets)
	}
	finishedAt := time.Now().UTC()

	failed := 0
	for _, t := range targets {
		if !t.OK {
			failed++
		}
	}
	status := http.StatusOK
	if failed > 0 {
		status = http.StatusBadGateway
	}
	resp := runResponse{
		Runtime: req.Runtime,
		Summary: runResponseSummary{
			Total:          len(targets),
			Succeeded:      len(targets) - failed,
			Failed:         failed,
			Fanout:         fanout,
			RetryCount:     retryCount,
			RetryBackoffMS: retryBackoff.Milliseconds(),
			DurationMS:     finishedAt.Sub(startedAt).Milliseconds(),
			StartedAt:      startedAt,
			FinishedAt:     finishedAt,
		},
		Targets: targets,
	}
	_ = s.store.AddRunRecord(model.RunRecord{
		ID:             fmt.Sprintf("run_%d", finishedAt.UnixNano()),
		Runtime:        req.Runtime,
		PromptPreview:  promptPreview(req.Prompt),
		TotalHosts:     resp.Summary.Total,
		SucceededHosts: resp.Summary.Succeeded,
		FailedHosts:    resp.Summary.Failed,
		Fanout:         resp.Summary.Fanout,
		StatusCode:     status,
		DurationMS:     resp.Summary.DurationMS,
		CreatedByKeyID: identity.KeyID,
		StartedAt:      resp.Summary.StartedAt,
		FinishedAt:     resp.Summary.FinishedAt,
		Targets:        toRunTargetSummaries(targets),
	})
	return status, resp
}

func (s *Server) startRunJobWorkers(workers int) {
	if workers <= 0 {
		workers = 1
	}
	s.runJobWorkers = workers
	for i := 0; i < workers; i++ {
		go s.runJobWorker()
	}
}

func (s *Server) recoverRunJobs() {
	jobs := s.store.ListRunJobs(1000)
	for i := len(jobs) - 1; i >= 0; i-- {
		job := jobs[i]
		switch job.Status {
		case runJobStatusPending:
			s.enqueueRecoveredRunJob(job.ID)
		case runJobStatusRunning:
			job.Status = runJobStatusPending
			job.Error = "server restarted before job completion; re-queued"
			if err := s.store.UpdateRunJob(job); err == nil {
				s.enqueueRecoveredRunJob(job.ID)
			}
		}
	}
}

func (s *Server) enqueueRecoveredRunJob(jobID string) {
	if s.enqueueStoredJob(jobID) {
		return
	}
	job, ok := s.store.GetRunJob(jobID)
	if !ok {
		return
	}
	finished := time.Now().UTC()
	job.Status = runJobStatusFailed
	job.ResultStatus = http.StatusServiceUnavailable
	job.Error = "job queue is full during startup recovery"
	job.FinishedAt = &finished
	_ = s.store.UpdateRunJob(job)
	_ = s.updateSessionRunState(job)
}

func (s *Server) enqueueStoredJob(jobID string) bool {
	select {
	case s.runJobs <- jobID:
		return true
	default:
		return false
	}
}

func (s *Server) appendRunJobEvent(jobID string, event runJobEvent) {
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	event.JobID = jobID

	s.mu.Lock()
	if s.eventBuffers == nil {
		s.eventBuffers = map[string][]runJobEvent{}
	}
	s.eventSeq++
	event.Seq = s.eventSeq
	buf := append(s.eventBuffers[jobID], event)
	if len(buf) > maxJobEventBacklog {
		buf = append([]runJobEvent(nil), buf[len(buf)-maxJobEventBacklog:]...)
	}
	s.eventBuffers[jobID] = buf
	s.mu.Unlock()
}

func (s *Server) appendRunJobEventForJob(job model.RunJobRecord, event runJobEvent) {
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	s.appendRunJobEvent(job.ID, event)
	s.appendSessionEventForJob(job, event)
}

func (s *Server) appendSessionEventForJob(job model.RunJobRecord, event runJobEvent) {
	sessionID := normalizeSessionID(job.SessionID, job.ID)
	if sessionID == "" {
		return
	}
	payloadMap := map[string]any{
		"job_id":    strings.TrimSpace(job.ID),
		"host_id":   strings.TrimSpace(event.HostID),
		"host_name": strings.TrimSpace(event.HostName),
		"attempt":   event.Attempt,
		"chunk":     event.Chunk,
		"exit_code": event.ExitCode,
		"error":     strings.TrimSpace(event.Error),
		"status":    strings.TrimSpace(event.Status),
	}
	payload, err := json.Marshal(payloadMap)
	if err != nil {
		return
	}
	persisted, err := s.store.AppendSessionEvent(model.SessionEvent{
		SessionID: sessionID,
		RunID:     strings.TrimSpace(job.ID),
		Type:      strings.TrimSpace(event.Type),
		Payload:   payload,
		CreatedAt: event.CreatedAt,
	})
	if err != nil {
		return
	}
	s.publishSessionEvent(persisted)
	if mappedType := mapSessionLifecycleEventType(job, event); mappedType != "" && mappedType != strings.TrimSpace(event.Type) {
		s.appendSessionStructuredEventAt(job, mappedType, payloadMap, event.CreatedAt)
	}
}

func (s *Server) appendSessionStructuredEvent(job model.RunJobRecord, eventType string, payload any) {
	s.appendSessionStructuredEventAt(job, eventType, payload, time.Now().UTC())
}

func (s *Server) appendSessionStructuredEventAt(job model.RunJobRecord, eventType string, payload any, createdAt time.Time) {
	eventType = strings.TrimSpace(eventType)
	if eventType == "" {
		return
	}
	sessionID := normalizeSessionID(job.SessionID, job.ID)
	if sessionID == "" {
		return
	}
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		return
	}
	persisted, err := s.store.AppendSessionEvent(model.SessionEvent{
		SessionID: sessionID,
		RunID:     strings.TrimSpace(job.ID),
		Type:      eventType,
		Payload:   rawPayload,
		CreatedAt: createdAt,
	})
	if err != nil {
		return
	}
	s.publishSessionEvent(persisted)
}

func mapSessionLifecycleEventType(job model.RunJobRecord, event runJobEvent) string {
	switch strings.TrimSpace(event.Type) {
	case "job.running":
		return "run.started"
	case "job.succeeded":
		return "run.completed"
	case "job.failed":
		return "run.failed"
	case "job.canceled":
		return "run.canceled"
	case "target.stdout":
		if strings.TrimSpace(job.Runtime) == "codex" {
			return "assistant.delta"
		}
	}
	return ""
}

func (s *Server) subscribeSessionStream(sessionID string, buffer int) (<-chan model.SessionEvent, func()) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		ch := make(chan model.SessionEvent)
		close(ch)
		return ch, func() {}
	}
	if buffer <= 0 {
		buffer = sessionStreamBuffer
	}
	sub := make(chan model.SessionEvent, buffer)
	s.mu.Lock()
	if s.streamSubs == nil {
		s.streamSubs = map[string]map[int64]chan model.SessionEvent{}
	}
	s.streamSubID++
	subID := s.streamSubID
	if s.streamSubs[sessionID] == nil {
		s.streamSubs[sessionID] = map[int64]chan model.SessionEvent{}
	}
	s.streamSubs[sessionID][subID] = sub
	s.mu.Unlock()

	var once sync.Once
	return sub, func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			bySession := s.streamSubs[sessionID]
			if bySession == nil {
				return
			}
			ch, ok := bySession[subID]
			if !ok {
				return
			}
			delete(bySession, subID)
			close(ch)
			if len(bySession) == 0 {
				delete(s.streamSubs, sessionID)
			}
		})
	}
}

func (s *Server) publishSessionEvent(event model.SessionEvent) {
	sessionID := strings.TrimSpace(event.SessionID)
	if sessionID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	bySession := s.streamSubs[sessionID]
	if len(bySession) == 0 {
		return
	}
	for subID, sub := range bySession {
		select {
		case sub <- event:
		default:
			close(sub)
			delete(bySession, subID)
		}
	}
	if len(bySession) == 0 {
		delete(s.streamSubs, sessionID)
	}
}

func (s *Server) closeSessionStreams(sessionID string) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	bySession := s.streamSubs[sessionID]
	if len(bySession) == 0 {
		delete(s.streamSubs, sessionID)
		return
	}
	for subID, ch := range bySession {
		close(ch)
		delete(bySession, subID)
	}
	delete(s.streamSubs, sessionID)
}

func (s *Server) listRunJobEvents(jobID string, afterSeq int64, limit int) ([]runJobEvent, int64) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	s.mu.Lock()
	buf := append([]runJobEvent(nil), s.eventBuffers[jobID]...)
	s.mu.Unlock()
	if len(buf) == 0 {
		return nil, afterSeq
	}
	out := make([]runJobEvent, 0, minInt(limit, len(buf)))
	next := afterSeq
	for _, event := range buf {
		if event.Seq <= afterSeq {
			continue
		}
		out = append(out, event)
		if event.Seq > next {
			next = event.Seq
		}
		if len(out) >= limit {
			break
		}
	}
	return out, next
}

func truncateChunkBytes(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	if len(raw) <= maxChunkEventBytes {
		return string(raw)
	}
	return string(raw[:maxChunkEventBytes]) + "\n...[chunk truncated]..."
}

func (s *Server) registerRunningJob(jobID string, cancel context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancels[jobID] = cancel
}

func (s *Server) unregisterRunningJob(jobID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cancels, jobID)
}

func (s *Server) requestJobCancel(jobID string) {
	s.mu.Lock()
	cancel := s.cancels[jobID]
	s.cancelRq[jobID] = true
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Server) takeJobCancelRequested(jobID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.cancelRq[jobID]
	delete(s.cancelRq, jobID)
	return v
}

func (s *Server) runJobWorker() {
	for jobID := range s.runJobs {
		s.executeQueuedJob(jobID)
	}
}

func (s *Server) executeQueuedJob(jobID string) {
	job, ok := s.store.GetRunJob(jobID)
	if !ok || job.Status != runJobStatusPending {
		return
	}
	atomic.AddInt64(&s.activeWorkers, 1)
	defer atomic.AddInt64(&s.activeWorkers, -1)
	started := time.Now().UTC()
	job.Status = runJobStatusRunning
	job.StartedAt = &started
	job.Error = ""
	if err := s.store.UpdateRunJob(job); err != nil {
		return
	}
	_ = s.updateSessionRunState(job)
	s.appendRunJobEventForJob(job, runJobEvent{Type: "job.running", Status: runJobStatusRunning})
	ctx, cancel := context.WithCancel(context.Background())
	s.registerRunningJob(jobID, cancel)
	defer s.unregisterRunningJob(jobID)

	switch job.Type {
	case "run":
		s.executeQueuedRunJob(ctx, job)
	case "sync":
		s.executeQueuedSyncJob(ctx, job)
	default:
		finished := time.Now().UTC()
		job.Status = runJobStatusFailed
		job.ResultStatus = http.StatusBadRequest
		job.Error = fmt.Sprintf("unsupported job type: %s", job.Type)
		job.FinishedAt = &finished
		_ = s.store.UpdateRunJob(job)
		_ = s.updateSessionRunState(job)
		s.appendRunJobEventForJob(job, runJobEvent{Type: "job.failed", Status: runJobStatusFailed, Error: job.Error})
	}
}

func (s *Server) executeQueuedRunJob(ctx context.Context, job model.RunJobRecord) {
	var req runRequest
	if err := json.Unmarshal(job.Request, &req); err != nil {
		finished := time.Now().UTC()
		job.Status = runJobStatusFailed
		job.ResultStatus = http.StatusBadRequest
		job.Error = fmt.Sprintf("decode run request: %v", err)
		job.FinishedAt = &finished
		_ = s.store.UpdateRunJob(job)
		_ = s.updateSessionRunState(job)
		s.appendRunJobEventForJob(job, runJobEvent{Type: "job.failed", Status: runJobStatusFailed, Error: job.Error})
		return
	}

	prepared, err := s.prepareRun(req)
	if err != nil {
		finished := time.Now().UTC()
		job.Status = runJobStatusFailed
		job.ResultStatus = http.StatusBadRequest
		job.Error = err.Error()
		job.FinishedAt = &finished
		_ = s.store.UpdateRunJob(job)
		_ = s.updateSessionRunState(job)
		s.appendRunJobEventForJob(job, runJobEvent{Type: "job.failed", Status: runJobStatusFailed, Error: job.Error})
		return
	}

	observer := &runProgressObserver{
		OnAttempt: func(host model.Host, attempt int) {
			s.appendRunJobEventForJob(job, runJobEvent{
				Type:     "target.started",
				HostID:   strings.TrimSpace(host.ID),
				HostName: strings.TrimSpace(host.Name),
				Attempt:  attempt,
			})
		},
		OnStdout: func(host model.Host, attempt int, chunk string) {
			if strings.TrimSpace(chunk) == "" {
				return
			}
			s.appendRunJobEventForJob(job, runJobEvent{
				Type:     "target.stdout",
				HostID:   strings.TrimSpace(host.ID),
				HostName: strings.TrimSpace(host.Name),
				Attempt:  attempt,
				Chunk:    chunk,
			})
		},
		OnStderr: func(host model.Host, attempt int, chunk string) {
			if strings.TrimSpace(chunk) == "" {
				return
			}
			s.appendRunJobEventForJob(job, runJobEvent{
				Type:     "target.stderr",
				HostID:   strings.TrimSpace(host.ID),
				HostName: strings.TrimSpace(host.Name),
				Attempt:  attempt,
				Chunk:    chunk,
			})
		},
		OnResult: func(target runTargetResult) {
			status := "ok"
			if !target.OK {
				status = "failed"
			}
			s.appendRunJobEventForJob(job, runJobEvent{
				Type:     "target.done",
				HostID:   strings.TrimSpace(target.Host.ID),
				HostName: strings.TrimSpace(target.Host.Name),
				Attempt:  target.Attempts,
				ExitCode: target.Result.ExitCode,
				Status:   status,
				Error:    strings.TrimSpace(target.Error),
			})
		},
	}

	status, resp := s.executePreparedRun(ctx, prepared, authIdentity{KeyID: job.CreatedByKeyID}, observer)
	finished := time.Now().UTC()
	job.ResultStatus = status
	job.FinishedAt = &finished
	canceled := s.takeJobCancelRequested(job.ID)
	rawResp, err := json.Marshal(resp)
	if err != nil {
		job.Status = runJobStatusFailed
		job.ResultStatus = http.StatusInternalServerError
		job.Error = fmt.Sprintf("encode run response: %v", err)
		_ = s.store.UpdateRunJob(job)
		_ = s.updateSessionRunState(job)
		s.appendRunJobEventForJob(job, runJobEvent{Type: "job.failed", Status: runJobStatusFailed, Error: job.Error})
		return
	}
	if canceled {
		job.Status = runJobStatusCanceled
		job.ResultStatus = jobResultCanceled
		job.Error = "canceled while running"
		s.appendRunJobEventForJob(job, runJobEvent{Type: "job.canceled", Status: runJobStatusCanceled, Error: job.Error})
	} else {
		job.Status = runJobStatusSucceeded
		job.Error = ""
		s.appendRunJobEventForJob(job, runJobEvent{Type: "job.succeeded", Status: runJobStatusSucceeded})
		s.appendSessionStructuredEvent(job, "assistant.completed", map[string]any{
			"run_id": strings.TrimSpace(job.ID),
		})
	}
	job.Response = rawResp
	job.TotalHosts = resp.Summary.Total
	job.SucceededHosts = resp.Summary.Succeeded
	job.FailedHosts = resp.Summary.Failed
	job.Fanout = resp.Summary.Fanout
	job.DurationMS = resp.Summary.DurationMS
	_ = s.store.UpdateRunJob(job)
	_ = s.updateSessionRunState(job)
}

func (s *Server) executeQueuedSyncJob(ctx context.Context, job model.RunJobRecord) {
	var req syncRequest
	if err := json.Unmarshal(job.Request, &req); err != nil {
		finished := time.Now().UTC()
		job.Status = runJobStatusFailed
		job.ResultStatus = http.StatusBadRequest
		job.Error = fmt.Sprintf("decode sync request: %v", err)
		job.FinishedAt = &finished
		_ = s.store.UpdateRunJob(job)
		_ = s.updateSessionRunState(job)
		return
	}
	status, resp, err := s.executeSyncRequest(ctx, req)
	finished := time.Now().UTC()
	job.ResultStatus = status
	job.FinishedAt = &finished
	canceled := s.takeJobCancelRequested(job.ID)
	if err != nil {
		if canceled || errors.Is(err, context.Canceled) {
			job.Status = runJobStatusCanceled
			job.ResultStatus = jobResultCanceled
			job.Error = "canceled while running"
			_ = s.store.UpdateRunJob(job)
			_ = s.updateSessionRunState(job)
			return
		}
		var badReq apiError
		if errors.As(err, &badReq) {
			job.ResultStatus = badReq.StatusCode
		}
		if job.ResultStatus == 0 {
			job.ResultStatus = http.StatusInternalServerError
		}
		job.Status = runJobStatusFailed
		job.Error = err.Error()
		_ = s.store.UpdateRunJob(job)
		_ = s.updateSessionRunState(job)
		return
	}
	rawResp, err := json.Marshal(resp)
	if err != nil {
		job.Status = runJobStatusFailed
		job.ResultStatus = http.StatusInternalServerError
		job.Error = fmt.Sprintf("encode sync response: %v", err)
		_ = s.store.UpdateRunJob(job)
		_ = s.updateSessionRunState(job)
		return
	}
	if canceled {
		job.Status = runJobStatusCanceled
		job.ResultStatus = jobResultCanceled
		job.Error = "canceled while running"
	} else {
		job.Status = runJobStatusSucceeded
		job.Error = ""
	}
	job.Response = rawResp
	job.TotalHosts = resp.Summary.Total
	job.SucceededHosts = resp.Summary.Succeeded
	job.FailedHosts = resp.Summary.Failed
	job.Fanout = resp.Summary.Fanout
	job.DurationMS = resp.Summary.DurationMS
	_ = s.store.UpdateRunJob(job)
	_ = s.updateSessionRunState(job)
}

func compactRunJob(job model.RunJobRecord) model.RunJobRecord {
	job.Request = nil
	job.Response = nil
	return job
}

func normalizeFanout(fanout int, hostCount int) int {
	if hostCount <= 0 {
		return 0
	}
	if fanout <= 0 {
		fanout = 3
	}
	if fanout > hostCount {
		fanout = hostCount
	}
	if fanout <= 0 {
		return 1
	}
	return fanout
}

func writeError(w http.ResponseWriter, err error) {
	var badReq apiError
	if errors.As(err, &badReq) {
		writeJSON(w, badReq.StatusCode, map[string]any{"error": badReq.Message})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
}

func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	var req syncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	status, resp, err := s.executeSyncRequest(r.Context(), req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, status, resp)
}

func (s *Server) handleDiscoverCodexModels(w http.ResponseWriter, r *http.Request) {
	hostID := strings.TrimSpace(r.URL.Query().Get("host_id"))
	host, err := s.resolveCodexModelHost(hostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	defaultModel, discoveredModels, probeErr := s.probeCodexModelCatalog(r.Context(), host)
	models := mergeModelCatalog(defaultModel, discoveredModels)
	resp := codexModelsResponse{
		Host:         host,
		DefaultModel: defaultModel,
		Models:       models,
	}
	if probeErr != nil {
		resp.Warning = probeErr.Error()
	} else if len(models) == 0 && strings.TrimSpace(defaultModel) == "" {
		resp.Warning = "no codex models discovered on target host"
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) prepareSync(req syncRequest) (preparedSync, error) {
	if strings.TrimSpace(req.Src) == "" || strings.TrimSpace(req.Dst) == "" {
		return preparedSync{}, apiError{StatusCode: http.StatusBadRequest, Message: "src and dst are required"}
	}
	if _, err := os.Stat(req.Src); err != nil {
		return preparedSync{}, apiError{StatusCode: http.StatusBadRequest, Message: fmt.Sprintf("invalid src path: %v", err)}
	}
	hosts, err := s.resolveHosts(req.HostID, req.HostIDs, req.AllHosts)
	if err != nil {
		return preparedSync{}, apiError{StatusCode: http.StatusBadRequest, Message: err.Error()}
	}
	return preparedSync{
		Request: req,
		Hosts:   hosts,
	}, nil
}

func (s *Server) executeSyncRequest(parentCtx context.Context, req syncRequest) (int, syncResponse, error) {
	prepared, err := s.prepareSync(req)
	if err != nil {
		return 0, syncResponse{}, err
	}
	status, resp := s.executePreparedSync(parentCtx, prepared)
	return status, resp, nil
}

func (s *Server) executePreparedSync(parentCtx context.Context, prepared preparedSync) (int, syncResponse) {
	req := prepared.Request
	timeout := 1800 * time.Second
	if req.TimeoutSec > 0 {
		timeout = time.Duration(req.TimeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(parentCtx, timeout)
	defer cancel()

	startedAt := time.Now().UTC()
	fanout := normalizeFanout(req.Fanout, len(prepared.Hosts))
	retryCount, retryBackoff := resolveRetryPolicy(req.RetryCount, req.RetryBackoffMS)
	maxOutputBytes := resolveMaxOutputBytes(req.MaxOutputKB)
	targets := s.runFanout(ctx, prepared.Hosts, fanout, func(host model.Host) runTargetResult {
		dst := resolveSyncDst(req.Dst, host.Workspace)
		res, syncErr, attempts := executeWithRetry(ctx, retryCount, retryBackoff, func(_ int) (executor.ExecResult, error) {
			return s.runRsyncViaSSH(
				ctx,
				host,
				req.Src,
				dst,
				executor.SyncOptions{
					Delete:   req.Delete,
					Excludes: req.Excludes,
				},
				executor.ExecOptions{
					MaxStdoutBytes: maxOutputBytes,
					MaxStderrBytes: maxOutputBytes,
				},
			)
		})
		msg, class, hint := errorDetails(syncErr)
		return runTargetResult{
			Host:       host,
			Result:     res,
			OK:         syncErr == nil,
			Error:      msg,
			ErrorClass: class,
			ErrorHint:  hint,
			Attempts:   attempts,
		}
	})
	finishedAt := time.Now().UTC()

	failed := 0
	for _, t := range targets {
		if !t.OK {
			failed++
		}
	}
	status := http.StatusOK
	if failed > 0 {
		status = http.StatusBadGateway
	}
	resp := syncResponse{
		Operation: "sync",
		Runtime:   "sync",
		Summary: runResponseSummary{
			Total:          len(targets),
			Succeeded:      len(targets) - failed,
			Failed:         failed,
			Fanout:         fanout,
			RetryCount:     retryCount,
			RetryBackoffMS: retryBackoff.Milliseconds(),
			DurationMS:     finishedAt.Sub(startedAt).Milliseconds(),
			StartedAt:      startedAt,
			FinishedAt:     finishedAt,
		},
		Targets: targets,
	}
	return status, resp
}

func (s *Server) handleDiscoverCodexSessions(w http.ResponseWriter, r *http.Request) {
	var req codexSessionsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	hosts, err := s.resolveHosts(req.HostID, req.HostIDs, req.AllHosts)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	limit := req.LimitPerHost
	if limit <= 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	timeout := 120 * time.Second
	if req.TimeoutSec > 0 {
		timeout = time.Duration(req.TimeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	fanout := normalizeFanout(req.Fanout, len(hosts))
	startedAt := time.Now().UTC()
	spec := buildCodexSessionDiscoverSpec(limit)
	targets := s.runFanout(ctx, hosts, fanout, func(host model.Host) runTargetResult {
		res, runErr := s.runViaSSH(
			ctx,
			host,
			spec,
			resolveWorkdir("", host.Workspace),
			executor.ExecOptions{
				MaxStdoutBytes: 512 * 1024,
				MaxStderrBytes: 256 * 1024,
			},
		)
		msg, class, hint := errorDetails(runErr)
		return runTargetResult{
			Host:       host,
			Result:     res,
			OK:         runErr == nil,
			Error:      msg,
			ErrorClass: class,
			ErrorHint:  hint,
		}
	})
	finishedAt := time.Now().UTC()
	failed := 0
	out := make([]codexSessionTarget, 0, len(targets))
	for _, t := range targets {
		item := codexSessionTarget{
			Host:       t.Host,
			Result:     t.Result,
			OK:         t.OK,
			Error:      t.Error,
			ErrorClass: t.ErrorClass,
			ErrorHint:  t.ErrorHint,
		}
		if t.OK {
			item.Sessions = parseCodexSessionDiscoverOutput(t.Result.Stdout)
		} else {
			failed++
		}
		out = append(out, item)
	}
	status := http.StatusOK
	if failed > 0 {
		status = http.StatusBadGateway
	}
	writeJSON(w, status, map[string]any{
		"operation": "codex_sessions_discover",
		"summary": runResponseSummary{
			Total:      len(out),
			Succeeded:  len(out) - failed,
			Failed:     failed,
			Fanout:     fanout,
			DurationMS: finishedAt.Sub(startedAt).Milliseconds(),
			StartedAt:  startedAt,
			FinishedAt: finishedAt,
		},
		"targets": out,
	})
}

func (s *Server) handleCleanupCodexSessions(w http.ResponseWriter, r *http.Request) {
	var req codexCleanupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	hosts, err := s.resolveHosts(req.HostID, req.HostIDs, req.AllHosts)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	olderHours := req.OlderThanHours
	if olderHours <= 0 {
		olderHours = 72
	}
	if olderHours > 24*365 {
		olderHours = 24 * 365
	}
	timeout := 240 * time.Second
	if req.TimeoutSec > 0 {
		timeout = time.Duration(req.TimeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	fanout := normalizeFanout(req.Fanout, len(hosts))
	startedAt := time.Now().UTC()
	spec := buildCodexSessionCleanupSpec(olderHours, req.DryRun)
	targets := s.runFanout(ctx, hosts, fanout, func(host model.Host) runTargetResult {
		res, runErr := s.runViaSSH(
			ctx,
			host,
			spec,
			resolveWorkdir("", host.Workspace),
			executor.ExecOptions{
				MaxStdoutBytes: 512 * 1024,
				MaxStderrBytes: 256 * 1024,
			},
		)
		msg, class, hint := errorDetails(runErr)
		return runTargetResult{
			Host:       host,
			Result:     res,
			OK:         runErr == nil,
			Error:      msg,
			ErrorClass: class,
			ErrorHint:  hint,
		}
	})
	finishedAt := time.Now().UTC()
	failed := 0
	out := make([]codexCleanupTarget, 0, len(targets))
	for _, t := range targets {
		paths := parsePathLines(t.Result.Stdout)
		item := codexCleanupTarget{
			Host:       t.Host,
			Result:     t.Result,
			OK:         t.OK,
			Error:      t.Error,
			ErrorClass: t.ErrorClass,
			ErrorHint:  t.ErrorHint,
			DryRun:     req.DryRun,
			Paths:      capStringList(paths, 200),
			PathCount:  len(paths),
			Candidates: len(paths),
		}
		if req.DryRun {
			item.Deleted = 0
		} else {
			item.Deleted = len(paths)
		}
		if !t.OK {
			failed++
		}
		out = append(out, item)
	}
	status := http.StatusOK
	if failed > 0 {
		status = http.StatusBadGateway
	}
	writeJSON(w, status, map[string]any{
		"operation": "codex_sessions_cleanup",
		"summary": runResponseSummary{
			Total:      len(out),
			Succeeded:  len(out) - failed,
			Failed:     failed,
			Fanout:     fanout,
			DurationMS: finishedAt.Sub(startedAt).Milliseconds(),
			StartedAt:  startedAt,
			FinishedAt: finishedAt,
		},
		"targets": out,
		"policy": map[string]any{
			"older_than_hours": olderHours,
			"dry_run":          req.DryRun,
		},
	})
}

func (s *Server) handleCodexPlatformLogin(w http.ResponseWriter, r *http.Request) {
	var req codexPlatformLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	host, err := s.resolveCodexModelHost(req.HostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	spec, action, err := buildCodexPlatformLoginSpec(req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	status, payload := s.executeCodexPlatformCommand(
		r.Context(),
		host,
		"codex_platform_login_"+action,
		spec,
		req.TimeoutSec,
		false,
	)
	writeJSON(w, status, payload)
}

func (s *Server) handleCodexPlatformMCP(w http.ResponseWriter, r *http.Request) {
	var req codexPlatformMCPRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	host, err := s.resolveCodexModelHost(req.HostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	spec, action, expectJSON, err := buildCodexPlatformMCPSpec(req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	status, payload := s.executeCodexPlatformCommand(
		r.Context(),
		host,
		"codex_platform_mcp_"+action,
		spec,
		req.TimeoutSec,
		expectJSON,
	)
	writeJSON(w, status, payload)
}

func (s *Server) handleCodexPlatformCloud(w http.ResponseWriter, r *http.Request) {
	var req codexPlatformCloudRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	host, err := s.resolveCodexModelHost(req.HostID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	spec, action, expectJSON, err := buildCodexPlatformCloudSpec(req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	status, payload := s.executeCodexPlatformCommand(
		r.Context(),
		host,
		"codex_platform_cloud_"+action,
		spec,
		req.TimeoutSec,
		expectJSON,
	)
	writeJSON(w, status, payload)
}

func (s *Server) executeCodexPlatformCommand(
	parentCtx context.Context,
	host model.Host,
	operation string,
	spec runtime.CommandSpec,
	timeoutSec int,
	expectJSON bool,
) (int, codexPlatformResult) {
	timeout := normalizeCodexPlatformTimeout(timeoutSec)
	ctx, cancel := context.WithTimeout(parentCtx, timeout)
	defer cancel()

	workdir := resolveWorkdir("", host.Workspace)
	res, runErr := s.runViaSSH(
		ctx,
		host,
		spec,
		workdir,
		executor.ExecOptions{
			MaxStdoutBytes: 1024 * 1024,
			MaxStderrBytes: 512 * 1024,
		},
	)
	msg, class, hint := errorDetails(runErr)
	payload := codexPlatformResult{
		Operation:  operation,
		Host:       host,
		Command:    append([]string{spec.Program}, spec.Args...),
		Workdir:    workdir,
		OK:         runErr == nil,
		Error:      msg,
		ErrorClass: class,
		ErrorHint:  hint,
		Result:     res,
	}
	if expectJSON && strings.TrimSpace(res.Stdout) != "" {
		var decoded any
		if err := json.Unmarshal([]byte(res.Stdout), &decoded); err == nil {
			payload.JSON = decoded
		}
	}
	if runErr != nil {
		return http.StatusBadGateway, payload
	}
	return http.StatusOK, payload
}

func normalizeCodexPlatformTimeout(v int) time.Duration {
	if v <= 0 {
		return 120 * time.Second
	}
	if v > 900 {
		v = 900
	}
	return time.Duration(v) * time.Second
}

func buildCodexPlatformLoginSpec(req codexPlatformLoginRequest) (runtime.CommandSpec, string, error) {
	action := strings.ToLower(strings.TrimSpace(req.Action))
	if action == "" {
		action = "status"
	}
	switch action {
	case "status":
		return runtime.CommandSpec{Program: "codex", Args: []string{"login", "status"}}, action, nil
	case "login_device":
		return runtime.CommandSpec{Program: "codex", Args: []string{"login", "--device-auth"}}, action, nil
	case "logout":
		return runtime.CommandSpec{Program: "codex", Args: []string{"logout"}}, action, nil
	default:
		return runtime.CommandSpec{}, "", fmt.Errorf("unsupported codex login action: %q", req.Action)
	}
}

func buildCodexPlatformMCPSpec(req codexPlatformMCPRequest) (runtime.CommandSpec, string, bool, error) {
	action := strings.ToLower(strings.TrimSpace(req.Action))
	if action == "" {
		action = "list"
	}
	args := []string{"mcp"}
	expectJSON := false
	name := strings.TrimSpace(req.Name)
	switch action {
	case "list":
		args = append(args, "list", "--json")
		expectJSON = true
	case "get":
		if name == "" {
			return runtime.CommandSpec{}, "", false, fmt.Errorf("name is required for mcp get")
		}
		args = append(args, "get", name, "--json")
		expectJSON = true
	case "add":
		if name == "" {
			return runtime.CommandSpec{}, "", false, fmt.Errorf("name is required for mcp add")
		}
		args = append(args, "add", name)
		url := strings.TrimSpace(req.URL)
		command := trimStringList(req.Command)
		if url != "" && len(command) > 0 {
			return runtime.CommandSpec{}, "", false, fmt.Errorf("mcp add accepts either url or command, not both")
		}
		if url != "" {
			args = append(args, "--url", url)
			if v := strings.TrimSpace(req.BearerTokenEnvVar); v != "" {
				args = append(args, "--bearer-token-env-var", v)
			}
			if len(req.Env) > 0 {
				return runtime.CommandSpec{}, "", false, fmt.Errorf("env is only supported for stdio mcp add")
			}
		} else {
			if len(command) == 0 {
				return runtime.CommandSpec{}, "", false, fmt.Errorf("command is required for stdio mcp add")
			}
			for _, envKV := range trimStringList(req.Env) {
				args = append(args, "--env", envKV)
			}
			args = append(args, "--")
			args = append(args, command...)
		}
	case "remove":
		if name == "" {
			return runtime.CommandSpec{}, "", false, fmt.Errorf("name is required for mcp remove")
		}
		args = append(args, "remove", name)
	case "login":
		if name == "" {
			return runtime.CommandSpec{}, "", false, fmt.Errorf("name is required for mcp login")
		}
		args = append(args, "login", name)
		scopes := trimStringList(req.Scopes)
		if len(scopes) > 0 {
			args = append(args, "--scopes", strings.Join(scopes, ","))
		}
	case "logout":
		if name == "" {
			return runtime.CommandSpec{}, "", false, fmt.Errorf("name is required for mcp logout")
		}
		args = append(args, "logout", name)
	default:
		return runtime.CommandSpec{}, "", false, fmt.Errorf("unsupported codex mcp action: %q", req.Action)
	}
	return runtime.CommandSpec{Program: "codex", Args: args}, action, expectJSON, nil
}

func buildCodexPlatformCloudSpec(req codexPlatformCloudRequest) (runtime.CommandSpec, string, bool, error) {
	action := strings.ToLower(strings.TrimSpace(req.Action))
	if action == "" {
		action = "list"
	}
	args := []string{"cloud"}
	expectJSON := false
	switch action {
	case "list":
		args = append(args, "list", "--json")
		expectJSON = true
		if envID := strings.TrimSpace(req.EnvID); envID != "" {
			args = append(args, "--env", envID)
		}
		if req.Limit > 0 {
			limit := req.Limit
			if limit < 1 {
				limit = 1
			}
			if limit > 20 {
				limit = 20
			}
			args = append(args, "--limit", strconv.Itoa(limit))
		}
		if cursor := strings.TrimSpace(req.Cursor); cursor != "" {
			args = append(args, "--cursor", cursor)
		}
	case "status":
		taskID := strings.TrimSpace(req.TaskID)
		if taskID == "" {
			return runtime.CommandSpec{}, "", false, fmt.Errorf("task_id is required for cloud status")
		}
		args = append(args, "status", taskID)
	case "exec":
		envID := strings.TrimSpace(req.EnvID)
		if envID == "" {
			return runtime.CommandSpec{}, "", false, fmt.Errorf("env_id is required for cloud exec")
		}
		args = append(args, "exec", "--env", envID)
		if req.Attempts > 0 {
			attempts := req.Attempts
			if attempts < 1 {
				attempts = 1
			}
			if attempts > 20 {
				attempts = 20
			}
			args = append(args, "--attempts", strconv.Itoa(attempts))
		}
		if branch := strings.TrimSpace(req.Branch); branch != "" {
			args = append(args, "--branch", branch)
		}
		if query := strings.TrimSpace(req.Query); query != "" {
			args = append(args, query)
		}
	case "diff":
		taskID := strings.TrimSpace(req.TaskID)
		if taskID == "" {
			return runtime.CommandSpec{}, "", false, fmt.Errorf("task_id is required for cloud diff")
		}
		args = append(args, "diff", taskID)
		if req.Attempt > 0 {
			args = append(args, "--attempt", strconv.Itoa(req.Attempt))
		}
	case "apply":
		taskID := strings.TrimSpace(req.TaskID)
		if taskID == "" {
			return runtime.CommandSpec{}, "", false, fmt.Errorf("task_id is required for cloud apply")
		}
		args = append(args, "apply", taskID)
		if req.Attempt > 0 {
			args = append(args, "--attempt", strconv.Itoa(req.Attempt))
		}
	default:
		return runtime.CommandSpec{}, "", false, fmt.Errorf("unsupported codex cloud action: %q", req.Action)
	}
	return runtime.CommandSpec{Program: "codex", Args: args}, action, expectJSON, nil
}

func buildCodexSessionDiscoverSpec(limitPerHost int) runtime.CommandSpec {
	script := fmt.Sprintf(`
set -e
limit=%d
if command -v python3 >/dev/null 2>&1; then
  py_exec=python3
elif command -v python >/dev/null 2>&1; then
  py_exec=python
else
  if [ -d "$HOME/.codex/sessions" ]; then
    find "$HOME/.codex/sessions" -type f -name "*.jsonl" -printf "%%T@|%%s|%%p\n" 2>/dev/null | sort -t'|' -k1,1nr | head -n "$limit"
  fi
  exit 0
fi

"$py_exec" - "$limit" <<'PY'
import json
import os
import sys

def parse_limit(argv):
    if len(argv) < 2:
        return 20
    try:
        v = int(argv[1])
        if v <= 0:
            return 20
        return min(v, 200)
    except Exception:
        return 20

limit = parse_limit(sys.argv)
home = os.path.expanduser("~")
sessions_root = os.path.join(home, ".codex", "sessions")
index_path = os.path.join(home, ".codex", "session_index.jsonl")

thread_names = {}
if os.path.isfile(index_path):
    try:
        with open(index_path, "r", encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    row = json.loads(raw)
                except Exception:
                    continue
                sid = str(row.get("id") or "").strip()
                title = str(row.get("thread_name") or "").strip()
                updated = str(row.get("updated_at") or "").strip()
                if not sid or not title:
                    continue
                prev = thread_names.get(sid)
                if prev is None or updated >= prev[1]:
                    thread_names[sid] = (title, updated)
    except Exception:
        pass

rows = []
if os.path.isdir(sessions_root):
    for root, _, files in os.walk(sessions_root):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            full = os.path.join(root, name)
            try:
                st = os.stat(full)
            except Exception:
                continue
            rows.append((st.st_mtime, st.st_size, full))

rows.sort(key=lambda item: item[0], reverse=True)
for mtime, size, full in rows[:limit]:
    sid = ""
    cwd = ""
    try:
        with open(full, "r", encoding="utf-8") as fh:
            first = fh.readline().strip()
        if first:
            item = json.loads(first)
            payload = item.get("payload") if isinstance(item, dict) else {}
            if isinstance(payload, dict):
                sid = str(payload.get("id") or "").strip()
                cwd = str(payload.get("cwd") or "").strip()
    except Exception:
        pass
    if not sid:
        base = os.path.basename(full)
        if base.endswith(".jsonl"):
            base = base[:-6]
        sid = base.rsplit("-", 1)[-1] if base.startswith("rollout-") else base
    title = thread_names.get(sid, ("", ""))[0] if sid else ""
    print(f"{mtime}|{size}|{full}|{sid}|{cwd}|{title}")
PY
`, limitPerHost)
	return runtime.CommandSpec{Program: "sh", Args: []string{"-lc", script}}
}

func buildCodexSessionCleanupSpec(olderHours int, dryRun bool) runtime.CommandSpec {
	minutes := olderHours * 60
	dryFlag := "0"
	if dryRun {
		dryFlag = "1"
	}
	script := fmt.Sprintf(`
set -e
target="$HOME/.codex/sessions"
if [ ! -d "$target" ]; then
  exit 0
fi
mins=%d
if [ "%s" = "1" ]; then
  find "$target" -type f -mmin +"$mins" -print 2>/dev/null
else
  find "$target" -type f -mmin +"$mins" -print -delete 2>/dev/null
fi
`, minutes, dryFlag)
	return runtime.CommandSpec{Program: "sh", Args: []string{"-lc", script}}
}

func buildCodexSessionDeleteSpec(sessionID string) runtime.CommandSpec {
	script := fmt.Sprintf(`
set -e
session_id=%q
if [ -z "$session_id" ]; then
  exit 0
fi
if command -v python3 >/dev/null 2>&1; then
  py_exec=python3
elif command -v python >/dev/null 2>&1; then
  py_exec=python
else
  target="$HOME/.codex/sessions"
  if [ -d "$target" ]; then
    find "$target" -type f -name "*$session_id*.jsonl" -print -delete 2>/dev/null
  fi
  if [ -f "$HOME/.codex/session_index.jsonl" ]; then
    tmp="$HOME/.codex/session_index.jsonl.tmp.$$"
    grep -v "\"id\"[[:space:]]*:[[:space:]]*\"$session_id\"" "$HOME/.codex/session_index.jsonl" >"$tmp" || true
    mv "$tmp" "$HOME/.codex/session_index.jsonl"
  fi
  exit 0
fi

"$py_exec" - "$session_id" <<'PY'
import json
import os
import sys

def infer_session_id_from_name(name: str) -> str:
    base = name
    if base.endswith(".jsonl"):
        base = base[:-6]
    if base.startswith("rollout-"):
        parts = base.split("-")
        if len(parts) >= 5:
            candidate = "-".join(parts[-5:]).strip()
            if candidate:
                return candidate
    return base.strip()

def file_matches(path: str, target_session_id: str) -> bool:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            first = fh.readline().strip()
        if first:
            row = json.loads(first)
            payload = row.get("payload") if isinstance(row, dict) else {}
            if isinstance(payload, dict):
                payload_id = str(payload.get("id") or "").strip()
                if payload_id == target_session_id:
                    return True
    except Exception:
        pass
    inferred = infer_session_id_from_name(os.path.basename(path))
    return inferred == target_session_id

def prune_empty_dirs(root_path: str) -> None:
    if not os.path.isdir(root_path):
        return
    for root, dirs, files in os.walk(root_path, topdown=False):
        if dirs or files:
            continue
        try:
            os.rmdir(root)
        except Exception:
            pass

def rewrite_session_index(index_path: str, target_session_id: str) -> None:
    if not os.path.isfile(index_path):
        return
    keep_lines = []
    changed = False
    try:
        with open(index_path, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.rstrip("\n")
                stripped = line.strip()
                if not stripped:
                    continue
                remove = False
                try:
                    row = json.loads(stripped)
                    row_id = str(row.get("id") or "").strip() if isinstance(row, dict) else ""
                    if row_id == target_session_id:
                        remove = True
                except Exception:
                    remove = False
                if remove:
                    changed = True
                    continue
                keep_lines.append(stripped)
    except Exception:
        return
    if not changed:
        return
    tmp_path = index_path + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            for line in keep_lines:
                fh.write(line + "\n")
        os.replace(tmp_path, index_path)
    except Exception:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass

session_id = str(sys.argv[1] if len(sys.argv) > 1 else "").strip()
if not session_id:
    raise SystemExit(0)

home = os.path.expanduser("~")
sessions_root = os.path.join(home, ".codex", "sessions")
index_path = os.path.join(home, ".codex", "session_index.jsonl")

matches = []
if os.path.isdir(sessions_root):
    for root, _, files in os.walk(sessions_root):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            full = os.path.join(root, name)
            if file_matches(full, session_id):
                matches.append(full)

for full in sorted(set(matches)):
    try:
        os.remove(full)
        print(full)
    except FileNotFoundError:
        continue
    except Exception:
        pass

prune_empty_dirs(sessions_root)
rewrite_session_index(index_path, session_id)
PY
`, sessionID)
	return runtime.CommandSpec{Program: "sh", Args: []string{"-lc", script}}
}

func parseCodexSessionDiscoverOutput(stdout string) []codexSessionInfo {
	lines := parsePathLines(stdout)
	out := make([]codexSessionInfo, 0, len(lines))
	for _, line := range lines {
		parts := strings.SplitN(line, "|", 6)
		if len(parts) < 3 {
			continue
		}
		updated, err := parseEpochSeconds(parts[0])
		if err != nil {
			continue
		}
		size, _ := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		path := strings.TrimSpace(parts[2])
		sessionID := inferSessionIDFromPath(path)
		cwd := ""
		threadName := ""
		if len(parts) >= 6 {
			if trimmed := strings.TrimSpace(parts[3]); trimmed != "" {
				sessionID = trimmed
			}
			cwd = strings.TrimSpace(parts[4])
			threadName = strings.TrimSpace(parts[5])
		}
		out = append(out, codexSessionInfo{
			SessionID:  sessionID,
			Path:       path,
			Cwd:        cwd,
			ThreadName: threadName,
			UpdatedAt:  updated,
			SizeBytes:  size,
		})
	}
	return out
}

func parseCodexSessionDeleteOutput(stdout string) []string {
	return parsePathLines(stdout)
}

func parseEpochSeconds(raw string) (time.Time, error) {
	v, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return time.Time{}, err
	}
	sec := int64(v)
	nsec := int64((v - float64(sec)) * float64(time.Second))
	return time.Unix(sec, nsec).UTC(), nil
}

func inferSessionIDFromPath(p string) string {
	base := path.Base(strings.TrimSpace(p))
	base = strings.TrimSuffix(base, path.Ext(base))
	if strings.HasPrefix(base, "rollout-") {
		parts := strings.Split(base, "-")
		if len(parts) >= 5 {
			candidate := strings.Join(parts[len(parts)-5:], "-")
			if strings.TrimSpace(candidate) != "" {
				return strings.TrimSpace(candidate)
			}
		}
	}
	if base != "" {
		return base
	}
	return strings.TrimSpace(p)
}

func parsePathLines(stdout string) []string {
	lines := strings.Split(stdout, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		v := strings.TrimSpace(line)
		if v == "" {
			continue
		}
		out = append(out, v)
	}
	return out
}

func capStringList(src []string, max int) []string {
	if len(src) <= max {
		return src
	}
	return src[:max]
}

func trimStringList(src []string) []string {
	if len(src) == 0 {
		return nil
	}
	out := make([]string, 0, len(src))
	for _, raw := range src {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

type probeRequest struct {
	Preflight bool `json:"preflight"`
}

func (s *Server) handleProbeHost(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h, ok := s.store.GetHost(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "host not found"})
		return
	}

	req := probeRequest{Preflight: true}
	if r.Body != nil {
		dec := json.NewDecoder(r.Body)
		if err := dec.Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
			return
		}
	}

	probeOutputOpts := executor.ExecOptions{MaxStdoutBytes: 64 * 1024, MaxStderrBytes: 64 * 1024}
	sshSpec := runtime.CommandSpec{Program: "echo", Args: []string{"ssh-ok"}}
	sshRes, sshErr := s.runViaSSH(r.Context(), h, sshSpec, "", probeOutputOpts)

	codexVersionSpec := runtime.CommandSpec{Program: "codex", Args: []string{"--version"}}
	codexVersionRes, codexVersionErr := s.runViaSSH(r.Context(), h, codexVersionSpec, resolveWorkdir("", h.Workspace), probeOutputOpts)

	codexLoginSpec := runtime.CommandSpec{Program: "codex", Args: []string{"login", "status"}}
	codexLoginRes, codexLoginErr := s.runViaSSH(r.Context(), h, codexLoginSpec, resolveWorkdir("", h.Workspace), probeOutputOpts)

	var preflight executor.SSHPreflightReport
	if req.Preflight {
		preflight = executor.RunSSHPreflight(h)
	}
	status := http.StatusOK
	if sshErr != nil || codexVersionErr != nil || (req.Preflight && !preflight.OK) {
		status = http.StatusBadGateway
	}
	resp := map[string]any{
		"host":        h,
		"ssh":         probeTargetPayload(sshErr, sshRes),
		"codex":       probeTargetPayload(codexVersionErr, codexVersionRes),
		"codex_login": probeTargetPayload(codexLoginErr, codexLoginRes),
	}
	if req.Preflight {
		resp["preflight"] = preflight
	}
	writeJSON(w, status, resp)
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func errorDetails(err error) (msg string, class string, hint string) {
	if err == nil {
		return "", "", ""
	}
	return errorText(err), strings.TrimSpace(executor.ErrorClassOf(err)), strings.TrimSpace(executor.ErrorHintOf(err))
}

func probeTargetPayload(err error, res executor.ExecResult) map[string]any {
	msg, class, hint := errorDetails(err)
	return map[string]any{
		"ok":          err == nil,
		"error":       msg,
		"error_class": class,
		"error_hint":  hint,
		"result":      res,
	}
}

func (s *Server) handleUploadImage(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(20 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid multipart form"})
		return
	}
	f, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing file"})
		return
	}
	defer f.Close()

	baseName := filepath.Base(strings.TrimSpace(header.Filename))
	if baseName == "" || baseName == "." || baseName == string(filepath.Separator) {
		baseName = "image.bin"
	}
	baseName = strings.ReplaceAll(baseName, " ", "_")
	baseName = strings.ReplaceAll(baseName, string(filepath.Separator), "_")
	baseName = strings.ReplaceAll(baseName, "/", "_")

	uploadDir := filepath.Join(os.TempDir(), "remote-llm-cli", "uploads")
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to prepare upload dir"})
		return
	}

	dstPath := filepath.Join(uploadDir, fmt.Sprintf("img_%d_%s", time.Now().UTC().UnixNano(), baseName))
	dst, err := os.Create(dstPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to create upload file"})
		return
	}
	defer dst.Close()

	n, err := io.Copy(dst, f)
	if err != nil {
		_ = os.Remove(dstPath)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to write upload file"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":  dstPath,
		"name":  baseName,
		"bytes": n,
	})
}

type runTargetResult struct {
	Host       model.Host          `json:"host"`
	Result     executor.ExecResult `json:"result"`
	OK         bool                `json:"ok"`
	Error      string              `json:"error,omitempty"`
	ErrorClass string              `json:"error_class,omitempty"`
	ErrorHint  string              `json:"error_hint,omitempty"`
	Attempts   int                 `json:"attempts,omitempty"`
	Codex      *codexJSONSummary   `json:"codex,omitempty"`
}

type codexJSONSummary struct {
	JSONL         bool   `json:"jsonl"`
	EventCount    int    `json:"event_count"`
	InvalidLines  int    `json:"invalid_lines,omitempty"`
	LastEventType string `json:"last_event_type,omitempty"`
	ParseError    string `json:"parse_error,omitempty"`
}

func (s *Server) runFanout(
	ctx context.Context,
	hosts []model.Host,
	fanout int,
	run func(host model.Host) runTargetResult,
) []runTargetResult {
	type task struct {
		index int
		host  model.Host
	}

	results := make([]runTargetResult, len(hosts))
	jobs := make(chan task)
	var wg sync.WaitGroup
	var mu sync.Mutex

	worker := func() {
		defer wg.Done()
		for job := range jobs {
			item := run(job.host)
			if item.Host.ID == "" {
				item.Host = job.host
			}
			mu.Lock()
			results[job.index] = item
			mu.Unlock()
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
	}

	for i := 0; i < fanout; i++ {
		wg.Add(1)
		go worker()
	}
loop:
	for i, h := range hosts {
		select {
		case <-ctx.Done():
			break loop
		case jobs <- task{index: i, host: h}:
		}
	}
	close(jobs)
	wg.Wait()

	for i := range results {
		if results[i].Host.ID != "" {
			continue
		}
		results[i] = runTargetResult{
			Host:       hosts[i],
			OK:         false,
			Error:      "not executed (context canceled before scheduling)",
			ErrorClass: string(executor.ErrorClassNetwork),
			ErrorHint:  "verify fanout/timeout settings and retry",
		}
	}
	return results
}

func (s *Server) resolveRunHosts(req runRequest) ([]model.Host, error) {
	return s.resolveHosts(req.HostID, req.HostIDs, req.AllHosts)
}

func (s *Server) resolveHosts(hostID string, hostIDs []string, allHosts bool) ([]model.Host, error) {
	hasSingle := strings.TrimSpace(hostID) != ""
	hasMany := len(hostIDs) > 0
	hasAll := allHosts

	selectorCount := 0
	if hasSingle {
		selectorCount++
	}
	if hasMany {
		selectorCount++
	}
	if hasAll {
		selectorCount++
	}
	if selectorCount == 0 {
		return nil, fmt.Errorf("one selector is required: host_id, host_ids, or all_hosts")
	}
	if selectorCount > 1 {
		return nil, fmt.Errorf("host selectors are mutually exclusive: use only one of host_id, host_ids, all_hosts")
	}

	if hasAll {
		hosts := s.store.ListHosts()
		if len(hosts) == 0 {
			return nil, fmt.Errorf("no hosts configured")
		}
		return hosts, nil
	}

	if hasSingle {
		h, ok := s.store.GetHost(strings.TrimSpace(hostID))
		if !ok {
			return nil, fmt.Errorf("host not found: %s", hostID)
		}
		return []model.Host{h}, nil
	}

	seen := map[string]struct{}{}
	out := make([]model.Host, 0, len(hostIDs))
	for _, id := range hostIDs {
		key := strings.TrimSpace(id)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		h, ok := s.store.GetHost(key)
		if !ok {
			return nil, fmt.Errorf("host not found: %s", key)
		}
		out = append(out, h)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("host_ids resolved to empty set")
	}
	return out, nil
}

func resolveWorkdir(requestWorkdir string, hostWorkspace string) string {
	if strings.TrimSpace(requestWorkdir) != "" {
		return requestWorkdir
	}
	return strings.TrimSpace(hostWorkspace)
}

func resolveSyncDst(requestDst string, hostWorkspace string) string {
	dst := strings.TrimSpace(requestDst)
	if dst == "" {
		return dst
	}
	if strings.HasPrefix(dst, "/") || strings.TrimSpace(hostWorkspace) == "" {
		return dst
	}
	return path.Join(strings.TrimSpace(hostWorkspace), dst)
}

func (s *Server) resolveCodexModelHost(hostID string) (model.Host, error) {
	if strings.TrimSpace(hostID) != "" {
		host, ok := s.store.GetHost(strings.TrimSpace(hostID))
		if !ok {
			return model.Host{}, fmt.Errorf("host not found: %s", hostID)
		}
		return host, nil
	}
	hosts := s.store.ListHosts()
	if len(hosts) == 0 {
		return model.Host{}, fmt.Errorf("no hosts configured")
	}
	for _, host := range hosts {
		if strings.EqualFold(strings.TrimSpace(host.ConnectionMode), "local") {
			return host, nil
		}
	}
	return hosts[0], nil
}

func (s *Server) probeCodexModelCatalog(ctx context.Context, host model.Host) (string, []string, error) {
	script := `
if command -v python3 >/dev/null 2>&1; then
  py_exec=python3
elif command -v python >/dev/null 2>&1; then
  py_exec=python
else
  if [ -f "$HOME/.codex/config.toml" ]; then
    grep -E '^[[:space:]]*model[[:space:]]*=' "$HOME/.codex/config.toml" | head -n1 \
      | sed -E 's/^[[:space:]]*model[[:space:]]*=[[:space:]]*"?(.*)"?[[:space:]]*$/\1/'
  fi
  exit 0
fi

"$py_exec" - <<'PY'
import json
import os
import re

home = os.path.expanduser("~")
config_path = os.path.join(home, ".codex", "config.toml")
cache_path = os.path.join(home, ".codex", "models_cache.json")

default_model = ""
if os.path.isfile(config_path):
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            for raw in fh:
                m = re.match(r'^\s*model\s*=\s*"([^"]+)"\s*$', raw)
                if m:
                    default_model = m.group(1).strip()
                    break
    except Exception:
        pass

models = []
if os.path.isfile(cache_path):
    try:
        with open(cache_path, "r", encoding="utf-8") as fh:
            cache = json.load(fh)
        items = cache.get("models")
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict):
                    slug = str(item.get("slug") or "").strip()
                    if slug:
                        models.append(slug)
    except Exception:
        pass

print(json.dumps({"default_model": default_model, "models": models}))
PY
`
	refreshScript := `
if [ ! -f "$HOME/.codex/models_cache.json" ] && command -v codex >/dev/null 2>&1; then
  codex exec --skip-git-repo-check --sandbox read-only --json "reply with exactly OK" >/dev/null 2>&1 || true
fi
`
	res, err := s.runViaSSH(
		ctx,
		host,
		runtime.CommandSpec{
			Program: "sh",
			Args:    []string{"-lc", refreshScript + "\n" + script},
		},
		"",
		executor.ExecOptions{
			MaxStdoutBytes: 32 * 1024,
			MaxStderrBytes: 32 * 1024,
		},
	)
	if err != nil {
		return "", nil, err
	}

	type payload struct {
		DefaultModel string   `json:"default_model"`
		Models       []string `json:"models"`
	}
	for _, line := range strings.Split(res.Stdout, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		var parsed payload
		if json.Unmarshal([]byte(trimmed), &parsed) == nil {
			return strings.TrimSpace(parsed.DefaultModel), normalizeModelList(parsed.Models), nil
		}
	}

	for _, line := range strings.Split(res.Stdout, "\n") {
		trimmed := strings.Trim(strings.TrimSpace(line), "\"'")
		if trimmed != "" {
			return trimmed, nil, nil
		}
	}
	return "", nil, nil
}

func normalizeModelList(input []string) []string {
	out := make([]string, 0, len(input))
	seen := map[string]struct{}{}
	for _, modelName := range input {
		trimmed := strings.TrimSpace(modelName)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func (s *Server) collectObservedCodexModels(limit int) []string {
	jobs := s.store.ListRunJobs(limit)
	out := make([]string, 0, 8)
	seen := map[string]struct{}{}
	for _, job := range jobs {
		if len(job.Request) == 0 {
			continue
		}
		var req struct {
			Runtime string `json:"runtime"`
			Codex   *struct {
				Model string `json:"model"`
			} `json:"codex"`
		}
		if err := json.Unmarshal(job.Request, &req); err != nil {
			continue
		}
		if strings.TrimSpace(req.Runtime) != "codex" || req.Codex == nil {
			continue
		}
		modelName := strings.TrimSpace(req.Codex.Model)
		if modelName == "" {
			continue
		}
		if _, ok := seen[modelName]; ok {
			continue
		}
		seen[modelName] = struct{}{}
		out = append(out, modelName)
	}
	return out
}

func mergeModelCatalog(defaultModel string, discovered []string) []string {
	out := make([]string, 0, 10)
	seen := map[string]struct{}{}
	appendIfNew := func(modelName string) {
		modelName = strings.TrimSpace(modelName)
		if modelName == "" {
			return
		}
		if _, ok := seen[modelName]; ok {
			return
		}
		seen[modelName] = struct{}{}
		out = append(out, modelName)
	}
	appendIfNew(defaultModel)
	for _, modelName := range discovered {
		appendIfNew(modelName)
	}
	return out
}

func normalizeHostConnectionMode(v string) (string, error) {
	mode := strings.ToLower(strings.TrimSpace(v))
	if mode == "" {
		return "ssh", nil
	}
	switch mode {
	case "ssh", "local":
		return mode, nil
	default:
		return "", fmt.Errorf("invalid connection_mode: %q", v)
	}
}

func normalizeSSHHostKeyPolicy(v string) (string, error) {
	trimmed := strings.ToLower(strings.TrimSpace(v))
	if trimmed == "" {
		return "", nil
	}
	switch trimmed {
	case executor.HostKeyPolicyAcceptNew, executor.HostKeyPolicyStrict, executor.HostKeyPolicyInsecureSkip:
		return trimmed, nil
	default:
		return "", fmt.Errorf("invalid ssh_host_key_policy: %q", v)
	}
}

func resolveRetryPolicy(retryCount int, retryBackoffMS int) (int, time.Duration) {
	const (
		maxRetryCount    = 5
		defaultBackoffMS = 1000
		minBackoffMS     = 100
		maxBackoffMS     = 30000
	)
	if retryCount < 0 {
		retryCount = 0
	}
	if retryCount > maxRetryCount {
		retryCount = maxRetryCount
	}
	if retryBackoffMS <= 0 {
		retryBackoffMS = defaultBackoffMS
	}
	if retryBackoffMS < minBackoffMS {
		retryBackoffMS = minBackoffMS
	}
	if retryBackoffMS > maxBackoffMS {
		retryBackoffMS = maxBackoffMS
	}
	return retryCount, time.Duration(retryBackoffMS) * time.Millisecond
}

func executeWithRetry(
	ctx context.Context,
	retryCount int,
	retryBackoff time.Duration,
	run func(attempt int) (executor.ExecResult, error),
) (executor.ExecResult, error, int) {
	attempts := 0
	var lastRes executor.ExecResult
	var lastErr error
	for {
		attempts++
		res, err := run(attempts)
		lastRes = res
		lastErr = err
		if err == nil {
			return res, nil, attempts
		}
		if attempts > retryCount {
			return lastRes, lastErr, attempts
		}
		select {
		case <-ctx.Done():
			return lastRes, fmt.Errorf("context canceled before retry: %w", ctx.Err()), attempts
		case <-time.After(retryBackoff):
		}
	}
}

func bearerToken(v string) (string, bool) {
	parts := strings.SplitN(strings.TrimSpace(v), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return "", false
	}
	if strings.TrimSpace(parts[1]) == "" {
		return "", false
	}
	return parts[1], true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

type responseCapture struct {
	http.ResponseWriter
	status int
}

func (rw *responseCapture) WriteHeader(status int) {
	rw.status = status
	rw.ResponseWriter.WriteHeader(status)
}

func (rw *responseCapture) Write(p []byte) (int, error) {
	if rw.status == 0 {
		rw.status = http.StatusOK
	}
	return rw.ResponseWriter.Write(p)
}

func (rw *responseCapture) Flush() {
	if flusher, ok := rw.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (s *Server) requestLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now().UTC()
		rw := &responseCapture{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r)
		if r.URL.Path == "/v1/healthz" {
			return
		}
		identity, _ := authIdentityFromContext(r.Context())
		_ = s.store.AddAuditEvent(model.AuditEvent{
			ID:             fmt.Sprintf("evt_%d", started.UnixNano()),
			Timestamp:      started,
			Method:         r.Method,
			Path:           r.URL.Path,
			StatusCode:     rw.status,
			DurationMS:     time.Since(started).Milliseconds(),
			RemoteAddr:     r.RemoteAddr,
			CreatedByKeyID: identity.KeyID,
			Action:         inferAction(r.Method, r.URL.Path),
		})
	})
}

func inferAction(method string, path string) string {
	switch {
	case method == http.MethodGet && path == "/v1/runtimes":
		return "runtime.list"
	case method == http.MethodGet && path == "/v1/hosts":
		return "host.list"
	case method == http.MethodPost && path == "/v1/hosts":
		return "host.upsert"
	case method == http.MethodDelete && strings.HasPrefix(path, "/v1/hosts/"):
		return "host.delete"
	case method == http.MethodPost && strings.HasPrefix(path, "/v1/hosts/") && strings.HasSuffix(path, "/probe"):
		return "host.probe"
	case method == http.MethodPost && path == "/v1/run":
		return "run.execute"
	case method == http.MethodPost && path == "/v1/jobs/run":
		return "job.run.enqueue"
	case method == http.MethodPost && path == "/v1/jobs/sync":
		return "job.sync.enqueue"
	case method == http.MethodGet && path == "/v1/projects":
		return "project.list"
	case method == http.MethodPost && path == "/v1/projects":
		return "project.upsert"
	case method == http.MethodDelete && strings.HasPrefix(path, "/v1/projects/"):
		return "project.delete"
	case method == http.MethodGet && path == "/v1/sessions":
		return "session.list"
	case method == http.MethodDelete && strings.HasPrefix(path, "/v1/sessions/"):
		return "session.delete"
	case method == http.MethodGet && path == "/v1/jobs":
		return "job.list"
	case method == http.MethodGet && strings.HasPrefix(path, "/v1/jobs/") && strings.HasSuffix(path, "/events"):
		return "job.events.list"
	case method == http.MethodGet && strings.HasPrefix(path, "/v1/sessions/") && strings.HasSuffix(path, "/events"):
		return "session.events.list"
	case method == http.MethodGet && strings.HasPrefix(path, "/v1/sessions/") && strings.HasSuffix(path, "/stream"):
		return "session.stream.open"
	case method == http.MethodGet && strings.HasPrefix(path, "/v1/sessions/"):
		return "session.get"
	case method == http.MethodGet && strings.HasPrefix(path, "/v1/jobs/"):
		return "job.get"
	case method == http.MethodPost && strings.HasPrefix(path, "/v1/jobs/") && strings.HasSuffix(path, "/cancel"):
		return "job.cancel"
	case method == http.MethodPost && path == "/v1/sync":
		return "sync.execute"
	case method == http.MethodGet && path == "/v1/codex/models":
		return "codex.models.discover"
	case method == http.MethodPost && path == "/v1/codex/sessions/discover":
		return "codex.sessions.discover"
	case method == http.MethodPost && path == "/v1/codex/sessions/cleanup":
		return "codex.sessions.cleanup"
	case method == http.MethodPost && path == "/v1/codex/platform/login":
		return "codex.platform.login"
	case method == http.MethodPost && path == "/v1/codex/platform/mcp":
		return "codex.platform.mcp"
	case method == http.MethodPost && path == "/v1/codex/platform/cloud":
		return "codex.platform.cloud"
	case method == http.MethodPost && path == "/v1/files/images":
		return "files.image.upload"
	case method == http.MethodGet && path == "/v1/metrics":
		return "metrics.get"
	case method == http.MethodGet && path == "/v1/admin/retention":
		return "retention.get"
	case method == http.MethodPost && path == "/v1/admin/retention":
		return "retention.set"
	case method == http.MethodGet && path == "/v1/runs":
		return "run.list"
	case method == http.MethodGet && path == "/v1/audit":
		return "audit.list"
	default:
		return "request"
	}
}

func authIdentityFromContext(ctx context.Context) (authIdentity, bool) {
	v := ctx.Value(authContextKey{})
	if v == nil {
		return authIdentity{}, false
	}
	identity, ok := v.(authIdentity)
	if !ok {
		return authIdentity{}, false
	}
	return identity, true
}

func collectHostIDs(hosts []model.Host) []string {
	out := make([]string, 0, len(hosts))
	for _, h := range hosts {
		id := strings.TrimSpace(h.ID)
		if id == "" {
			continue
		}
		out = append(out, id)
	}
	return out
}

func normalizeSessionID(sessionID string, fallback string) string {
	trimmed := strings.TrimSpace(sessionID)
	if trimmed != "" {
		return trimmed
	}
	return strings.TrimSpace(fallback)
}

func projectBindingID(hostID string, pathValue string) string {
	hostID = strings.TrimSpace(hostID)
	if hostID == "" {
		hostID = "local"
	}
	pathValue = strings.TrimSpace(pathValue)
	if pathValue == "" {
		pathValue = "/"
	}
	return "project_" + hostID + "::" + pathValue
}

func deriveSessionTitle(promptPreview string, sessionID string) string {
	title := strings.TrimSpace(promptPreview)
	if title == "" {
		return strings.TrimSpace(sessionID)
	}
	if len(title) <= 80 {
		return title
	}
	return strings.TrimSpace(title[:80])
}

func (s *Server) ensureSessionBinding(job model.RunJobRecord, req runRequest, hosts []model.Host) (bool, string, error) {
	sessionID := normalizeSessionID(job.SessionID, job.ID)
	if sessionID == "" {
		return false, "", nil
	}
	primaryHost := model.Host{}
	if len(hosts) > 0 {
		primaryHost = hosts[0]
	}
	projectPath := strings.TrimSpace(resolveWorkdir(req.Workdir, primaryHost.Workspace))
	if projectPath == "" {
		projectPath = "/home/ecs-user"
	}
	project := model.ProjectRecord{
		ID:       projectBindingID(primaryHost.ID, projectPath),
		HostID:   strings.TrimSpace(primaryHost.ID),
		HostName: strings.TrimSpace(primaryHost.Name),
		Path:     projectPath,
		Runtime:  strings.TrimSpace(job.Runtime),
	}
	projectRecord, err := s.store.UpsertProject(project)
	if err != nil {
		return false, "", fmt.Errorf("upsert project binding: %w", err)
	}

	existing, exists := s.store.GetSession(sessionID)
	title := deriveSessionTitle(job.PromptPreview, sessionID)
	if exists && strings.TrimSpace(existing.Title) != "" {
		title = strings.TrimSpace(existing.Title)
	}
	titleUpdated := !exists
	if exists && strings.TrimSpace(existing.Title) != strings.TrimSpace(title) {
		titleUpdated = true
	}
	session := model.SessionRecord{
		ID:               sessionID,
		ProjectID:        projectRecord.ID,
		HostID:           strings.TrimSpace(primaryHost.ID),
		Path:             projectPath,
		Runtime:          strings.TrimSpace(job.Runtime),
		RuntimeSessionID: existing.RuntimeSessionID,
		Title:            title,
		LastRunID:        strings.TrimSpace(job.ID),
		LastStatus:       strings.TrimSpace(job.Status),
	}
	if _, err := s.store.UpsertSession(session); err != nil {
		return false, "", fmt.Errorf("upsert session binding: %w", err)
	}
	return titleUpdated, title, nil
}

func (s *Server) updateSessionRunState(job model.RunJobRecord) error {
	sessionID := normalizeSessionID(job.SessionID, job.ID)
	if sessionID == "" {
		return nil
	}
	session, ok := s.store.GetSession(sessionID)
	if !ok {
		return nil
	}
	session.LastRunID = strings.TrimSpace(job.ID)
	session.LastStatus = strings.TrimSpace(job.Status)
	if strings.TrimSpace(session.Runtime) == "" {
		session.Runtime = strings.TrimSpace(job.Runtime)
	}
	_, err := s.store.UpsertSession(session)
	return err
}

func toRunTargetSummaries(targets []runTargetResult) []model.RunTargetSummary {
	out := make([]model.RunTargetSummary, 0, len(targets))
	for _, t := range targets {
		out = append(out, model.RunTargetSummary{
			HostID:     t.Host.ID,
			HostName:   t.Host.Name,
			OK:         t.OK,
			ExitCode:   t.Result.ExitCode,
			DurationMS: t.Result.DurationMS,
			Error:      strings.TrimSpace(t.Error),
			ErrorClass: strings.TrimSpace(t.ErrorClass),
		})
	}
	return out
}

func promptPreview(prompt string) string {
	trimmed := strings.TrimSpace(prompt)
	if len(trimmed) <= 240 {
		return trimmed
	}
	return trimmed[:240]
}

func syncPreview(src string, dst string) string {
	preview := strings.TrimSpace(src) + " -> " + strings.TrimSpace(dst)
	if len(preview) <= 240 {
		return preview
	}
	return preview[:240]
}

func parseTimeQuery(raw string) time.Time {
	v := strings.TrimSpace(raw)
	if v == "" {
		return time.Time{}
	}
	if unixSec, err := strconv.ParseInt(v, 10, 64); err == nil {
		return time.Unix(unixSec, 0).UTC()
	}
	if parsed, err := time.Parse(time.RFC3339, v); err == nil {
		return parsed.UTC()
	}
	return time.Time{}
}

func splitQueryCSV(raw string) map[string]struct{} {
	items := strings.Split(strings.TrimSpace(raw), ",")
	out := map[string]struct{}{}
	for _, item := range items {
		v := strings.ToLower(strings.TrimSpace(item))
		if v == "" {
			continue
		}
		out[v] = struct{}{}
	}
	return out
}

func setContains(set map[string]struct{}, key string) bool {
	_, ok := set[strings.ToLower(strings.TrimSpace(key))]
	return ok
}

func jobMatchesHost(job model.RunJobRecord, hostID string) bool {
	hostID = strings.TrimSpace(hostID)
	if hostID == "" {
		return true
	}
	for _, id := range job.HostIDs {
		if strings.TrimSpace(id) == hostID {
			return true
		}
	}
	if len(job.HostIDs) == 0 {
		var fallback struct {
			HostID  string   `json:"host_id"`
			HostIDs []string `json:"host_ids"`
		}
		if err := json.Unmarshal(job.Request, &fallback); err == nil {
			if strings.TrimSpace(fallback.HostID) == hostID {
				return true
			}
			for _, id := range fallback.HostIDs {
				if strings.TrimSpace(id) == hostID {
					return true
				}
			}
		}
	}
	return false
}

func parseLimit(r *http.Request, fallback int, max int) int {
	raw := strings.TrimSpace(r.URL.Query().Get("limit"))
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return fallback
	}
	if v > max {
		return max
	}
	return v
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func resolveMaxOutputBytes(maxOutputKB int) int {
	const (
		defaultKB = 256
		maxKB     = 4096
	)
	if maxOutputKB <= 0 {
		return defaultKB * 1024
	}
	if maxOutputKB > maxKB {
		maxOutputKB = maxKB
	}
	return maxOutputKB * 1024
}

func annotateCodexJSONSummary(targets []runTargetResult) {
	for i := range targets {
		summary := parseCodexJSONSummary(targets[i].Result.Stdout)
		targets[i].Codex = &summary
	}
}

func parseCodexJSONSummary(stdout string) codexJSONSummary {
	out := codexJSONSummary{JSONL: true}
	scanner := bufio.NewScanner(strings.NewReader(stdout))
	scanner.Buffer(make([]byte, 0, 1024), 2*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			out.InvalidLines++
			if out.ParseError == "" {
				out.ParseError = err.Error()
			}
			continue
		}
		out.EventCount++
		if typ, ok := event["type"].(string); ok {
			out.LastEventType = typ
		}
	}
	if err := scanner.Err(); err != nil && out.ParseError == "" {
		out.ParseError = err.Error()
	}
	return out
}

func ValidateConfig(dataPath string) error {
	if strings.TrimSpace(dataPath) == "" {
		return errors.New("data path is required")
	}
	if !strings.Contains(dataPath, ".json") {
		return fmt.Errorf("data path should be a json file path")
	}
	return nil
}
