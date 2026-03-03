package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/accesskey"
	"github.com/hellsoul86/remote-llm-cli/server/internal/executor"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
	"github.com/hellsoul86/remote-llm-cli/server/internal/store"
)

func TestResolveRunHostsSingle(t *testing.T) {
	s, hosts := makeTestServerWithHosts(t)
	got, err := s.resolveRunHosts(runRequest{HostID: hosts[0].ID})
	if err != nil {
		t.Fatalf("resolveRunHosts returned error: %v", err)
	}
	if len(got) != 1 || got[0].ID != hosts[0].ID {
		t.Fatalf("unexpected hosts: %#v", got)
	}
}

func TestResolveRunHostsManyDedup(t *testing.T) {
	s, hosts := makeTestServerWithHosts(t)
	got, err := s.resolveRunHosts(runRequest{HostIDs: []string{hosts[0].ID, hosts[1].ID, hosts[0].ID}})
	if err != nil {
		t.Fatalf("resolveRunHosts returned error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 hosts, got %d", len(got))
	}
	if got[0].ID != hosts[0].ID || got[1].ID != hosts[1].ID {
		t.Fatalf("unexpected host order: %#v", got)
	}
}

func TestResolveRunHostsAll(t *testing.T) {
	s, hosts := makeTestServerWithHosts(t)
	got, err := s.resolveRunHosts(runRequest{AllHosts: true})
	if err != nil {
		t.Fatalf("resolveRunHosts returned error: %v", err)
	}
	if len(got) != len(hosts) {
		t.Fatalf("expected %d hosts, got %d", len(hosts), len(got))
	}
}

func TestResolveRunHostsMutualExclusive(t *testing.T) {
	s, hosts := makeTestServerWithHosts(t)
	_, err := s.resolveRunHosts(runRequest{HostID: hosts[0].ID, AllHosts: true})
	if err == nil {
		t.Fatalf("expected error for mixed selectors")
	}
}

func TestInferAction(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
		want   string
	}{
		{name: "runtimes", method: http.MethodGet, path: "/v1/runtimes", want: "runtime.list"},
		{name: "hosts list", method: http.MethodGet, path: "/v1/hosts", want: "host.list"},
		{name: "hosts upsert", method: http.MethodPost, path: "/v1/hosts", want: "host.upsert"},
		{name: "host delete", method: http.MethodDelete, path: "/v1/hosts/h_1", want: "host.delete"},
		{name: "host probe dynamic", method: http.MethodPost, path: "/v1/hosts/h_1/probe", want: "host.probe"},
		{name: "run execute", method: http.MethodPost, path: "/v1/run", want: "run.execute"},
		{name: "run enqueue", method: http.MethodPost, path: "/v1/jobs/run", want: "job.run.enqueue"},
		{name: "sync enqueue", method: http.MethodPost, path: "/v1/jobs/sync", want: "job.sync.enqueue"},
		{name: "job list", method: http.MethodGet, path: "/v1/jobs", want: "job.list"},
		{name: "job get", method: http.MethodGet, path: "/v1/jobs/job_1", want: "job.get"},
		{name: "job cancel", method: http.MethodPost, path: "/v1/jobs/job_1/cancel", want: "job.cancel"},
		{name: "sync execute", method: http.MethodPost, path: "/v1/sync", want: "sync.execute"},
		{name: "codex sessions discover", method: http.MethodPost, path: "/v1/codex/sessions/discover", want: "codex.sessions.discover"},
		{name: "codex sessions cleanup", method: http.MethodPost, path: "/v1/codex/sessions/cleanup", want: "codex.sessions.cleanup"},
		{name: "metrics get", method: http.MethodGet, path: "/v1/metrics", want: "metrics.get"},
		{name: "retention get", method: http.MethodGet, path: "/v1/admin/retention", want: "retention.get"},
		{name: "retention set", method: http.MethodPost, path: "/v1/admin/retention", want: "retention.set"},
		{name: "run list", method: http.MethodGet, path: "/v1/runs", want: "run.list"},
		{name: "audit list", method: http.MethodGet, path: "/v1/audit", want: "audit.list"},
		{name: "unknown", method: http.MethodPatch, path: "/v1/other", want: "request"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := inferAction(tc.method, tc.path)
			if got != tc.want {
				t.Fatalf("inferAction(%q,%q)=%q want=%q", tc.method, tc.path, got, tc.want)
			}
		})
	}
}

func TestNormalizeFanout(t *testing.T) {
	if got := normalizeFanout(0, 5); got != 3 {
		t.Fatalf("normalizeFanout default=%d want=3", got)
	}
	if got := normalizeFanout(10, 4); got != 4 {
		t.Fatalf("normalizeFanout cap=%d want=4", got)
	}
	if got := normalizeFanout(1, 0); got != 0 {
		t.Fatalf("normalizeFanout empty hosts=%d want=0", got)
	}
}

func TestResolveSyncDst(t *testing.T) {
	got := resolveSyncDst("project", "/srv/work")
	if got != "/srv/work/project" {
		t.Fatalf("resolveSyncDst relative mismatch: got=%q", got)
	}
	got = resolveSyncDst("/tmp/data", "/srv/work")
	if got != "/tmp/data" {
		t.Fatalf("resolveSyncDst absolute mismatch: got=%q", got)
	}
}

func TestResolveRetryPolicy(t *testing.T) {
	retries, backoff := resolveRetryPolicy(10, 1)
	if retries != 5 {
		t.Fatalf("retries=%d want=5", retries)
	}
	if backoff != 100*time.Millisecond {
		t.Fatalf("backoff=%s want=100ms", backoff)
	}
}

func TestExecuteWithRetry(t *testing.T) {
	calls := 0
	res, err, attempts := executeWithRetry(context.Background(), 2, time.Millisecond, func() (executor.ExecResult, error) {
		calls++
		if calls < 3 {
			return executor.ExecResult{ExitCode: 1}, context.DeadlineExceeded
		}
		return executor.ExecResult{ExitCode: 0}, nil
	})
	if err != nil {
		t.Fatalf("executeWithRetry err=%v", err)
	}
	if attempts != 3 {
		t.Fatalf("attempts=%d want=3", attempts)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit=%d want=0", res.ExitCode)
	}
}

func TestNormalizeSSHHostKeyPolicy(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "", want: "", wantErr: false},
		{in: "accept-new", want: "accept-new", wantErr: false},
		{in: "strict", want: "strict", wantErr: false},
		{in: "insecure-ignore", want: "insecure-ignore", wantErr: false},
		{in: "bad-policy", wantErr: true},
	}
	for _, tc := range cases {
		got, err := normalizeSSHHostKeyPolicy(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("normalizeSSHHostKeyPolicy(%q) should fail", tc.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("normalizeSSHHostKeyPolicy(%q) error: %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("normalizeSSHHostKeyPolicy(%q)=%q want=%q", tc.in, got, tc.want)
		}
	}
}

func TestNormalizeHostConnectionMode(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "", want: "ssh"},
		{in: "ssh", want: "ssh"},
		{in: "local", want: "local"},
		{in: "LOCAL", want: "local"},
		{in: "invalid", wantErr: true},
	}
	for _, tc := range cases {
		got, err := normalizeHostConnectionMode(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("normalizeHostConnectionMode(%q) should fail", tc.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("normalizeHostConnectionMode(%q) error: %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("normalizeHostConnectionMode(%q)=%q want=%q", tc.in, got, tc.want)
		}
	}
}

func TestErrorDetailsFromClassifiedError(t *testing.T) {
	msg, class, hint := errorDetails(&executor.ClassifiedError{
		Class:   executor.ErrorClassAuth,
		Hint:    "verify key",
		Message: "permission denied",
		Cause:   errors.New("exit"),
	})
	if msg != "permission denied" {
		t.Fatalf("msg=%q want=permission denied", msg)
	}
	if class != "auth" {
		t.Fatalf("class=%q want=auth", class)
	}
	if hint != "verify key" {
		t.Fatalf("hint=%q want=verify key", hint)
	}
}

func TestSplitQueryCSV(t *testing.T) {
	set := splitQueryCSV("running, failed ,")
	if !setContains(set, "running") || !setContains(set, "failed") {
		t.Fatalf("unexpected set contents: %#v", set)
	}
	if setContains(set, "pending") {
		t.Fatalf("pending should not be present")
	}
}

func TestJobMatchesHost(t *testing.T) {
	job := model.RunJobRecord{HostIDs: []string{"h_1", "h_2"}}
	if !jobMatchesHost(job, "h_2") {
		t.Fatalf("job should match host h_2")
	}
	if jobMatchesHost(job, "h_3") {
		t.Fatalf("job should not match host h_3")
	}
}

func TestCORSPreflightReturnsNoContent(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	s := New(st, runtime.NewRegistry(runtime.NewCodexAdapter()))
	h := s.Handler()

	req := httptest.NewRequest(http.MethodOptions, "/v1/runtimes", nil)
	req.Header.Set("Origin", "https://example.com")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status=%d want=%d", rr.Code, http.StatusNoContent)
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("allow-origin=%q want=*", got)
	}
	if got := rr.Header().Get("Access-Control-Allow-Headers"); got == "" {
		t.Fatalf("allow-headers should not be empty")
	}
}

func TestCORSHeadersPresentOnAuthenticatedResponse(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	token := addTestAccessKey(t, st)
	s := New(st, runtime.NewRegistry(runtime.NewCodexAdapter()))
	h := s.Handler()

	req := httptest.NewRequest(http.MethodGet, "/v1/runtimes", nil)
	req.Header.Set("Origin", "https://example.com")
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d body=%s", rr.Code, http.StatusOK, rr.Body.String())
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("allow-origin=%q want=*", got)
	}
}

func addTestAccessKey(t *testing.T, st *store.Store) string {
	t.Helper()
	full, prefix, secret, err := accesskey.Generate()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	hash, err := accesskey.HashSecret(secret)
	if err != nil {
		t.Fatalf("hash key: %v", err)
	}
	if err := st.AddKey(model.AccessKey{
		ID:        "k_test",
		Name:      "test",
		Prefix:    prefix,
		Hash:      hash,
		CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("add key: %v", err)
	}
	return full
}

func makeTestServerWithHosts(t *testing.T) (*Server, []model.Host) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	host1, err := st.UpsertHost(model.Host{Name: "h1", Host: "10.0.0.1", User: "u1", Port: 22})
	if err != nil {
		t.Fatalf("upsert host1: %v", err)
	}
	host2, err := st.UpsertHost(model.Host{Name: "h2", Host: "10.0.0.2", User: "u2", Port: 22})
	if err != nil {
		t.Fatalf("upsert host2: %v", err)
	}
	s := New(st, runtime.NewRegistry(runtime.NewCodexAdapter()))
	return s, []model.Host{host1, host2}
}
