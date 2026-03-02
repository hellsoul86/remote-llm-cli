package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/accesskey"
	"github.com/hellsoul86/remote-llm-cli/server/internal/executor"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
	"github.com/hellsoul86/remote-llm-cli/server/internal/store"
)

type Server struct {
	store    *store.Store
	runtimes *runtime.Registry
}

type authIdentity struct {
	KeyID     string
	KeyPrefix string
}

type authContextKey struct{}

func New(st *store.Store, rt *runtime.Registry) *Server {
	return &Server{store: st, runtimes: rt}
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
	mux.Handle("POST /v1/sync", s.withAuth(http.HandlerFunc(s.handleSync)))
	mux.Handle("GET /v1/runs", s.withAuth(http.HandlerFunc(s.handleListRuns)))
	mux.Handle("GET /v1/audit", s.withAuth(http.HandlerFunc(s.handleListAudit)))

	return s.requestLogMiddleware(mux)
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
	if strings.TrimSpace(h.Name) == "" || strings.TrimSpace(h.Host) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "name and host are required"})
		return
	}
	h, err := s.store.UpsertHost(h)
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

func (s *Server) handleListAudit(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 100, 500)
	writeJSON(w, http.StatusOK, map[string]any{"events": s.store.ListAuditEvents(limit)})
}

type runRequest struct {
	HostID         string                   `json:"host_id,omitempty"`
	HostIDs        []string                 `json:"host_ids,omitempty"`
	AllHosts       bool                     `json:"all_hosts,omitempty"`
	Fanout         int                      `json:"fanout,omitempty"`
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

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	var req runRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	hosts, err := s.resolveHosts(req.HostID, req.HostIDs, req.AllHosts)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if err := runtime.ValidateRuntime(req.Runtime); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	adapter, ok := s.runtimes.Get(req.Runtime)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported runtime"})
		return
	}
	spec, err := adapter.BuildRunCommand(runtime.RunRequest{
		Prompt:    req.Prompt,
		Workdir:   req.Workdir,
		ExtraArgs: req.ExtraArgs,
		Codex:     req.Codex,
	})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	timeout := 600 * time.Second
	if req.TimeoutSec > 0 {
		timeout = time.Duration(req.TimeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	startedAt := time.Now().UTC()
	fanout := req.Fanout
	if fanout <= 0 {
		fanout = 3
	}
	if fanout > len(hosts) {
		fanout = len(hosts)
	}
	retryCount, retryBackoff := resolveRetryPolicy(req.RetryCount, req.RetryBackoffMS)
	maxOutputBytes := resolveMaxOutputBytes(req.MaxOutputKB)
	targets := s.runFanout(ctx, hosts, fanout, func(host model.Host) runTargetResult {
		res, runErr, attempts := executeWithRetry(ctx, retryCount, retryBackoff, func() (executor.ExecResult, error) {
			return executor.RunViaSSH(
				ctx,
				host,
				spec,
				resolveWorkdir(req.Workdir, host.Workspace),
				executor.ExecOptions{
					MaxStdoutBytes: maxOutputBytes,
					MaxStderrBytes: maxOutputBytes,
				},
			)
		})
		return runTargetResult{
			Host:     host,
			Result:   res,
			OK:       runErr == nil,
			Error:    errText(runErr),
			Attempts: attempts,
		}
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

	resp := map[string]any{
		"runtime": req.Runtime,
		"summary": map[string]any{
			"total":            len(targets),
			"succeeded":        len(targets) - failed,
			"failed":           failed,
			"fanout":           fanout,
			"retry_count":      retryCount,
			"retry_backoff_ms": retryBackoff.Milliseconds(),
			"duration_ms":      finishedAt.Sub(startedAt).Milliseconds(),
			"started_at":       startedAt,
			"finished_at":      finishedAt,
		},
		"targets": targets,
	}

	identity, _ := authIdentityFromContext(r.Context())
	_ = s.store.AddRunRecord(model.RunRecord{
		ID:             fmt.Sprintf("run_%d", finishedAt.UnixNano()),
		Runtime:        req.Runtime,
		PromptPreview:  promptPreview(req.Prompt),
		TotalHosts:     len(targets),
		SucceededHosts: len(targets) - failed,
		FailedHosts:    failed,
		Fanout:         fanout,
		StatusCode:     status,
		DurationMS:     finishedAt.Sub(startedAt).Milliseconds(),
		CreatedByKeyID: identity.KeyID,
		StartedAt:      startedAt,
		FinishedAt:     finishedAt,
		Targets:        toRunTargetSummaries(targets),
	})

	writeJSON(w, status, resp)
}

func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	var req syncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	if strings.TrimSpace(req.Src) == "" || strings.TrimSpace(req.Dst) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "src and dst are required"})
		return
	}
	if _, err := os.Stat(req.Src); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": fmt.Sprintf("invalid src path: %v", err)})
		return
	}
	hosts, err := s.resolveHosts(req.HostID, req.HostIDs, req.AllHosts)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	timeout := 1800 * time.Second
	if req.TimeoutSec > 0 {
		timeout = time.Duration(req.TimeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	startedAt := time.Now().UTC()
	fanout := req.Fanout
	if fanout <= 0 {
		fanout = 3
	}
	if fanout > len(hosts) {
		fanout = len(hosts)
	}
	retryCount, retryBackoff := resolveRetryPolicy(req.RetryCount, req.RetryBackoffMS)
	maxOutputBytes := resolveMaxOutputBytes(req.MaxOutputKB)
	targets := s.runFanout(ctx, hosts, fanout, func(host model.Host) runTargetResult {
		dst := resolveSyncDst(req.Dst, host.Workspace)
		res, syncErr, attempts := executeWithRetry(ctx, retryCount, retryBackoff, func() (executor.ExecResult, error) {
			return executor.RunRsyncViaSSH(
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
		return runTargetResult{
			Host:     host,
			Result:   res,
			OK:       syncErr == nil,
			Error:    errText(syncErr),
			Attempts: attempts,
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
	writeJSON(w, status, map[string]any{
		"operation": "sync",
		"summary": map[string]any{
			"total":            len(targets),
			"succeeded":        len(targets) - failed,
			"failed":           failed,
			"fanout":           fanout,
			"retry_count":      retryCount,
			"retry_backoff_ms": retryBackoff.Milliseconds(),
			"duration_ms":      finishedAt.Sub(startedAt).Milliseconds(),
			"started_at":       startedAt,
			"finished_at":      finishedAt,
		},
		"targets": targets,
	})
}

func (s *Server) handleProbeHost(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h, ok := s.store.GetHost(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "host not found"})
		return
	}
	probeOutputOpts := executor.ExecOptions{MaxStdoutBytes: 64 * 1024, MaxStderrBytes: 64 * 1024}
	sshSpec := runtime.CommandSpec{Program: "echo", Args: []string{"ssh-ok"}}
	sshRes, sshErr := executor.RunViaSSH(r.Context(), h, sshSpec, "", probeOutputOpts)

	codexVersionSpec := runtime.CommandSpec{Program: "codex", Args: []string{"--version"}}
	codexVersionRes, codexVersionErr := executor.RunViaSSH(r.Context(), h, codexVersionSpec, resolveWorkdir("", h.Workspace), probeOutputOpts)

	codexLoginSpec := runtime.CommandSpec{Program: "codex", Args: []string{"login", "status"}}
	codexLoginRes, codexLoginErr := executor.RunViaSSH(r.Context(), h, codexLoginSpec, resolveWorkdir("", h.Workspace), probeOutputOpts)

	status := http.StatusOK
	if sshErr != nil || codexVersionErr != nil {
		status = http.StatusBadGateway
	}
	writeJSON(w, status, map[string]any{
		"host": h,
		"ssh": map[string]any{
			"ok":     sshErr == nil,
			"error":  errAny(sshErr),
			"result": sshRes,
		},
		"codex": map[string]any{
			"ok":     codexVersionErr == nil,
			"error":  errAny(codexVersionErr),
			"result": codexVersionRes,
		},
		"codex_login": map[string]any{
			"ok":     codexLoginErr == nil,
			"error":  errAny(codexLoginErr),
			"result": codexLoginRes,
		},
	})
}

func errAny(err error) any {
	if err == nil {
		return nil
	}
	return err.Error()
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

type runTargetResult struct {
	Host     model.Host          `json:"host"`
	Result   executor.ExecResult `json:"result"`
	OK       bool                `json:"ok"`
	Error    string              `json:"error,omitempty"`
	Attempts int                 `json:"attempts,omitempty"`
	Codex    *codexJSONSummary   `json:"codex,omitempty"`
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
			Host:  hosts[i],
			OK:    false,
			Error: "not executed (context canceled before scheduling)",
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
	run func() (executor.ExecResult, error),
) (executor.ExecResult, error, int) {
	attempts := 0
	var lastRes executor.ExecResult
	var lastErr error
	for {
		attempts++
		res, err := run()
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
	case method == http.MethodPost && path == "/v1/sync":
		return "sync.execute"
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
