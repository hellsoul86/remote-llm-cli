package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/accesskey"
	"github.com/hellsoul86/remote-llm-cli/server/internal/executor"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
	"github.com/hellsoul86/remote-llm-cli/server/internal/store"
)

func TestAsyncRunJobLifecycleSuccess(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()

	srv.runViaSSH = func(_ context.Context, _ model.Host, _ runtime.CommandSpec, _ string, _ executor.ExecOptions) (executor.ExecResult, error) {
		now := time.Now().UTC()
		return executor.ExecResult{
			ExitCode:   0,
			Stdout:     "ok",
			DurationMS: 5,
			StartedAt:  now,
			FinishedAt: now,
		}, nil
	}

	enqueueBody := map[string]any{
		"runtime": "codex",
		"prompt":  "smoke",
		"host_id": host.ID,
		"fanout":  1,
	}
	var enqueueResp struct {
		Job model.RunJobRecord `json:"job"`
	}
	status := doJSON(t, httpSrv.Client(), http.MethodPost, httpSrv.URL+"/v1/jobs/run", token, enqueueBody, &enqueueResp)
	if status != http.StatusAccepted {
		t.Fatalf("enqueue status=%d want=202", status)
	}
	if enqueueResp.Job.ID == "" {
		t.Fatalf("enqueue returned empty job id")
	}

	final := waitJobTerminal(t, httpSrv, token, enqueueResp.Job.ID, 3*time.Second)
	if final.Status != runJobStatusSucceeded {
		t.Fatalf("job status=%q want=%q", final.Status, runJobStatusSucceeded)
	}
	if final.ResultStatus != http.StatusOK {
		t.Fatalf("job result_status=%d want=200", final.ResultStatus)
	}
}

func TestAsyncRunJobEvents(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()

	srv.runViaSSH = func(_ context.Context, _ model.Host, _ runtime.CommandSpec, _ string, opts executor.ExecOptions) (executor.ExecResult, error) {
		if opts.OnStdoutChunk != nil {
			opts.OnStdoutChunk([]byte("stream-start\n"))
			opts.OnStdoutChunk([]byte("stream-done\n"))
		}
		if opts.OnStderrChunk != nil {
			opts.OnStderrChunk([]byte("warn: sample\n"))
		}
		now := time.Now().UTC()
		return executor.ExecResult{
			ExitCode:   0,
			Stdout:     "ok",
			DurationMS: 5,
			StartedAt:  now,
			FinishedAt: now,
		}, nil
	}

	enqueueBody := map[string]any{
		"runtime": "codex",
		"prompt":  "stream smoke",
		"host_id": host.ID,
		"fanout":  1,
	}
	var enqueueResp struct {
		Job model.RunJobRecord `json:"job"`
	}
	status := doJSON(t, httpSrv.Client(), http.MethodPost, httpSrv.URL+"/v1/jobs/run", token, enqueueBody, &enqueueResp)
	if status != http.StatusAccepted {
		t.Fatalf("enqueue status=%d want=202", status)
	}
	final := waitJobTerminal(t, httpSrv, token, enqueueResp.Job.ID, 3*time.Second)
	if final.Status != runJobStatusSucceeded {
		t.Fatalf("job status=%q want=%q", final.Status, runJobStatusSucceeded)
	}

	var eventResp struct {
		Events []runJobEvent `json:"events"`
	}
	eventsStatus := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v1/jobs/%s/events?after=0&limit=200", httpSrv.URL, enqueueResp.Job.ID),
		token,
		nil,
		&eventResp,
	)
	if eventsStatus != http.StatusOK {
		t.Fatalf("events status=%d want=200", eventsStatus)
	}
	if len(eventResp.Events) == 0 {
		t.Fatalf("expected non-empty job events")
	}
	has := map[string]bool{}
	joined := ""
	for _, event := range eventResp.Events {
		has[event.Type] = true
		joined += event.Chunk
	}
	for _, typ := range []string{"job.queued", "job.running", "target.started", "target.stdout", "target.done", "job.succeeded"} {
		if !has[typ] {
			t.Fatalf("missing event type %q in %#v", typ, has)
		}
	}
	if !strings.Contains(joined, "stream-start") || !strings.Contains(joined, "stream-done") {
		t.Fatalf("stream chunks missing in events: %q", joined)
	}
}

func TestAsyncRunJobCancelFlow(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()

	srv.runViaSSH = func(ctx context.Context, _ model.Host, _ runtime.CommandSpec, _ string, _ executor.ExecOptions) (executor.ExecResult, error) {
		<-ctx.Done()
		return executor.ExecResult{ExitCode: -1}, ctx.Err()
	}

	enqueueBody := map[string]any{
		"runtime": "codex",
		"prompt":  "wait",
		"host_id": host.ID,
		"fanout":  1,
	}
	var enqueueResp struct {
		Job model.RunJobRecord `json:"job"`
	}
	status := doJSON(t, httpSrv.Client(), http.MethodPost, httpSrv.URL+"/v1/jobs/run", token, enqueueBody, &enqueueResp)
	if status != http.StatusAccepted {
		t.Fatalf("enqueue status=%d want=202", status)
	}

	waitJobState(t, httpSrv, token, enqueueResp.Job.ID, runJobStatusRunning, 3*time.Second)

	var cancelResp struct {
		State string             `json:"state"`
		Job   model.RunJobRecord `json:"job"`
	}
	cancelStatus := doJSON(t, httpSrv.Client(), http.MethodPost, httpSrv.URL+"/v1/jobs/"+enqueueResp.Job.ID+"/cancel", token, nil, &cancelResp)
	if cancelStatus != http.StatusAccepted {
		t.Fatalf("cancel status=%d want=202", cancelStatus)
	}

	final := waitJobTerminal(t, httpSrv, token, enqueueResp.Job.ID, 3*time.Second)
	if final.Status != runJobStatusCanceled {
		t.Fatalf("job status=%q want=%q", final.Status, runJobStatusCanceled)
	}
	if final.ResultStatus != jobResultCanceled {
		t.Fatalf("job result_status=%d want=%d", final.ResultStatus, jobResultCanceled)
	}
}

func TestRecoverPendingRunJobOnStartup(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	host, err := st.UpsertHost(model.Host{Name: "h1", Host: "127.0.0.1", User: "u1", Port: 22})
	if err != nil {
		t.Fatalf("upsert host: %v", err)
	}
	rawReq, err := json.Marshal(runRequest{
		Runtime: "codex",
		Prompt:  "recover",
		HostID:  host.ID,
		Fanout:  1,
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	if err := st.AddRunJob(model.RunJobRecord{
		ID:            "job_recover",
		Type:          "run",
		Status:        runJobStatusPending,
		Runtime:       "codex",
		PromptPreview: "recover",
		QueuedAt:      time.Now().UTC(),
		Fanout:        1,
		HostIDs:       []string{host.ID},
		Request:       rawReq,
	}); err != nil {
		t.Fatalf("add run job: %v", err)
	}

	srv := &Server{
		store:    st,
		runtimes: runtime.NewRegistry(runtime.NewCodexAdapter()),
		runJobs:  make(chan string, runJobQueueSize),
		cancels:  map[string]context.CancelFunc{},
		cancelRq: map[string]bool{},
		runViaSSH: func(_ context.Context, _ model.Host, _ runtime.CommandSpec, _ string, _ executor.ExecOptions) (executor.ExecResult, error) {
			return executor.ExecResult{ExitCode: 0}, nil
		},
		runRsyncViaSSH: executor.RunRsyncViaSSH,
	}
	srv.startRunJobWorkers(1)
	srv.recoverRunJobs()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		job, ok := st.GetRunJob("job_recover")
		if ok && job.Status == runJobStatusSucceeded {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	job, _ := st.GetRunJob("job_recover")
	t.Fatalf("recovered job did not finish: status=%q result_status=%d", job.Status, job.ResultStatus)
}

func newAuthedTestServer(t *testing.T) (*Server, *httptest.Server, string, model.Host) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	host, err := st.UpsertHost(model.Host{Name: "h1", Host: "127.0.0.1", User: "u1", Port: 22})
	if err != nil {
		t.Fatalf("upsert host: %v", err)
	}
	fullKey, prefix, secret, err := accesskey.Generate()
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
	_ = fullKey
	srv := New(st, runtime.NewRegistry(runtime.NewCodexAdapter()))
	httpSrv := httptest.NewServer(srv.Handler())
	return srv, httpSrv, fullKey, host
}

func doJSON(t *testing.T, client *http.Client, method string, url string, token string, body any, out any) int {
	t.Helper()
	var raw []byte
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		raw = buf
	}
	req, err := http.NewRequest(method, url, bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()
	if out != nil {
		if err := json.NewDecoder(res.Body).Decode(out); err != nil {
			t.Fatalf("decode response: %v", err)
		}
	}
	return res.StatusCode
}

func waitJobState(t *testing.T, httpSrv *httptest.Server, token string, jobID string, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var out struct {
			Job model.RunJobRecord `json:"job"`
		}
		_ = doJSON(t, httpSrv.Client(), http.MethodGet, fmt.Sprintf("%s/v1/jobs/%s", httpSrv.URL, jobID), token, nil, &out)
		if out.Job.Status == want {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	var out struct {
		Job model.RunJobRecord `json:"job"`
	}
	_ = doJSON(t, httpSrv.Client(), http.MethodGet, fmt.Sprintf("%s/v1/jobs/%s", httpSrv.URL, jobID), token, nil, &out)
	t.Fatalf("job did not reach state %q, current=%q", want, out.Job.Status)
}

func waitJobTerminal(t *testing.T, httpSrv *httptest.Server, token string, jobID string, timeout time.Duration) model.RunJobRecord {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var out struct {
			Job model.RunJobRecord `json:"job"`
		}
		_ = doJSON(t, httpSrv.Client(), http.MethodGet, fmt.Sprintf("%s/v1/jobs/%s", httpSrv.URL, jobID), token, nil, &out)
		switch out.Job.Status {
		case runJobStatusSucceeded, runJobStatusFailed, runJobStatusCanceled:
			return out.Job
		}
		time.Sleep(25 * time.Millisecond)
	}
	var out struct {
		Job model.RunJobRecord `json:"job"`
	}
	_ = doJSON(t, httpSrv.Client(), http.MethodGet, fmt.Sprintf("%s/v1/jobs/%s", httpSrv.URL, jobID), token, nil, &out)
	t.Fatalf("job did not reach terminal state, current=%q", out.Job.Status)
	return model.RunJobRecord{}
}
