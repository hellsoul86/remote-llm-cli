package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
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

func TestSessionEventsEndpointFromRunJob(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()

	srv.runViaSSH = func(_ context.Context, _ model.Host, _ runtime.CommandSpec, _ string, opts executor.ExecOptions) (executor.ExecResult, error) {
		if opts.OnStdoutChunk != nil {
			opts.OnStdoutChunk([]byte("{\"type\":\"thread.started\"}\n"))
		}
		now := time.Now().UTC()
		return executor.ExecResult{
			ExitCode:   0,
			Stdout:     "{\"type\":\"assistant_message\",\"text\":\"ok\"}\n",
			DurationMS: 5,
			StartedAt:  now,
			FinishedAt: now,
		}, nil
	}

	const sessionID = "session_stream_1"
	enqueueBody := map[string]any{
		"runtime":    "codex",
		"prompt":     "stream to session endpoint",
		"host_id":    host.ID,
		"session_id": sessionID,
		"fanout":     1,
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
	if final.SessionID != sessionID {
		t.Fatalf("job session_id=%q want=%q", final.SessionID, sessionID)
	}

	var eventResp struct {
		SessionID string               `json:"session_id"`
		After     int64                `json:"after"`
		NextAfter int64                `json:"next_after"`
		Events    []model.SessionEvent `json:"events"`
	}
	eventsStatus := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v1/sessions/%s/events?after=0&limit=200", httpSrv.URL, sessionID),
		token,
		nil,
		&eventResp,
	)
	if eventsStatus != http.StatusOK {
		t.Fatalf("session events status=%d want=200", eventsStatus)
	}
	if eventResp.SessionID != sessionID {
		t.Fatalf("session_id=%q want=%q", eventResp.SessionID, sessionID)
	}
	if len(eventResp.Events) == 0 {
		t.Fatalf("expected non-empty session events")
	}
	has := map[string]bool{}
	for _, event := range eventResp.Events {
		has[event.Type] = true
		if event.SessionID != sessionID {
			t.Fatalf("event session_id=%q want=%q", event.SessionID, sessionID)
		}
	}
	for _, typ := range []string{"job.queued", "job.running", "target.started", "target.stdout", "target.done", "job.succeeded"} {
		if !has[typ] {
			t.Fatalf("missing session event type %q in %#v", typ, has)
		}
	}
	if eventResp.NextAfter <= 0 {
		t.Fatalf("next_after=%d want>0", eventResp.NextAfter)
	}

	var cursorResp struct {
		Events []model.SessionEvent `json:"events"`
	}
	cursorStatus := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v1/sessions/%s/events?after=%d&limit=200", httpSrv.URL, sessionID, eventResp.NextAfter),
		token,
		nil,
		&cursorResp,
	)
	if cursorStatus != http.StatusOK {
		t.Fatalf("session events cursor status=%d want=200", cursorStatus)
	}
	if len(cursorResp.Events) != 0 {
		t.Fatalf("expected no events after latest cursor, got=%d", len(cursorResp.Events))
	}
}

func TestSessionSSEStreamResumesFromLastEventID(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_sse_resume"
	first, err := srv.store.AppendSessionEvent(model.SessionEvent{
		SessionID: sessionID,
		RunID:     "job_resume",
		Type:      "run.started",
		Payload:   json.RawMessage(`{"status":"running"}`),
		CreatedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("append first session event: %v", err)
	}
	second, err := srv.store.AppendSessionEvent(model.SessionEvent{
		SessionID: sessionID,
		RunID:     "job_resume",
		Type:      "assistant.completed",
		Payload:   json.RawMessage(`{"text":"ok"}`),
		CreatedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("append second session event: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		fmt.Sprintf("%s/v1/sessions/%s/stream", httpSrv.URL, sessionID),
		nil,
	)
	if err != nil {
		t.Fatalf("new stream request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Last-Event-ID", strconv.FormatInt(first.Seq, 10))
	res, err := httpSrv.Client().Do(req)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("stream status=%d want=200", res.StatusCode)
	}

	reader := bufio.NewReader(res.Body)
	event := readSSEMessage(t, reader, 2*time.Second)
	if event.Event != "session.event" {
		t.Fatalf("event=%q want=session.event payload=%q", event.Event, event.Data)
	}
	if event.ID != strconv.FormatInt(second.Seq, 10) {
		t.Fatalf("event id=%q want=%d", event.ID, second.Seq)
	}
	var payload model.SessionEvent
	if err := json.Unmarshal([]byte(event.Data), &payload); err != nil {
		t.Fatalf("decode stream event payload: %v", err)
	}
	if payload.Seq != second.Seq || payload.SessionID != sessionID {
		t.Fatalf("unexpected event payload: %#v", payload)
	}
}

func TestSessionSSEStreamReceivesLivePublish(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_sse_live"
	base, err := srv.store.AppendSessionEvent(model.SessionEvent{
		SessionID: sessionID,
		RunID:     "job_live_seed",
		Type:      "run.started",
		Payload:   json.RawMessage(`{"seed":true}`),
		CreatedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("append seed event: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		fmt.Sprintf("%s/v1/sessions/%s/stream?after=%d", httpSrv.URL, sessionID, base.Seq),
		nil,
	)
	if err != nil {
		t.Fatalf("new stream request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := httpSrv.Client().Do(req)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("stream status=%d want=200", res.StatusCode)
	}

	reader := bufio.NewReader(res.Body)
	ready := readSSEMessage(t, reader, 2*time.Second)
	if ready.Event != "session.ready" {
		t.Fatalf("event=%q want=session.ready payload=%q", ready.Event, ready.Data)
	}

	srv.appendSessionEventForJob(
		model.RunJobRecord{ID: "job_live_emit", SessionID: sessionID},
		runJobEvent{
			Type:      "assistant.delta",
			Chunk:     "hello-stream",
			CreatedAt: time.Now().UTC(),
		},
	)

	event := readSSEMessage(t, reader, 2*time.Second)
	if event.Event != "session.event" {
		t.Fatalf("event=%q want=session.event payload=%q", event.Event, event.Data)
	}
	var payload model.SessionEvent
	if err := json.Unmarshal([]byte(event.Data), &payload); err != nil {
		t.Fatalf("decode stream event payload: %v", err)
	}
	if payload.SessionID != sessionID {
		t.Fatalf("session_id=%q want=%q", payload.SessionID, sessionID)
	}
	if payload.Type != "assistant.delta" {
		t.Fatalf("event type=%q want=assistant.delta", payload.Type)
	}
}

func TestSessionBindingAndNormalizedLifecycleEvents(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()

	srv.runViaSSH = func(_ context.Context, _ model.Host, _ runtime.CommandSpec, _ string, opts executor.ExecOptions) (executor.ExecResult, error) {
		if opts.OnStdoutChunk != nil {
			opts.OnStdoutChunk([]byte("{\"type\":\"assistant.delta\",\"delta\":\"hello\"}\n"))
		}
		now := time.Now().UTC()
		return executor.ExecResult{
			ExitCode:   0,
			Stdout:     "{\"type\":\"assistant.completed\",\"text\":\"done\"}\n",
			DurationMS: 5,
			StartedAt:  now,
			FinishedAt: now,
		}, nil
	}

	const sessionID = "session_binding_1"
	enqueueBody := map[string]any{
		"runtime":    "codex",
		"prompt":     "Investigate deployment health and summarize",
		"host_id":    host.ID,
		"session_id": sessionID,
		"fanout":     1,
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

	var getSessionResp struct {
		Session model.SessionRecord `json:"session"`
	}
	getStatus := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v1/sessions/%s", httpSrv.URL, sessionID),
		token,
		nil,
		&getSessionResp,
	)
	if getStatus != http.StatusOK {
		t.Fatalf("get session status=%d want=200", getStatus)
	}
	if getSessionResp.Session.LastStatus != runJobStatusSucceeded {
		t.Fatalf("session last_status=%q want=succeeded", getSessionResp.Session.LastStatus)
	}
	if getSessionResp.Session.ProjectID == "" {
		t.Fatalf("session project_id should not be empty")
	}
	if getSessionResp.Session.Title == "" {
		t.Fatalf("session title should not be empty")
	}

	var listProjectsResp struct {
		Projects []model.ProjectRecord `json:"projects"`
	}
	projectStatus := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v1/projects?host_id=%s", httpSrv.URL, host.ID),
		token,
		nil,
		&listProjectsResp,
	)
	if projectStatus != http.StatusOK {
		t.Fatalf("list projects status=%d want=200", projectStatus)
	}
	if len(listProjectsResp.Projects) == 0 {
		t.Fatalf("expected at least one project")
	}

	var listSessionsResp struct {
		Sessions []model.SessionRecord `json:"sessions"`
	}
	sessionsStatus := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v1/sessions?project_id=%s", httpSrv.URL, getSessionResp.Session.ProjectID),
		token,
		nil,
		&listSessionsResp,
	)
	if sessionsStatus != http.StatusOK {
		t.Fatalf("list sessions status=%d want=200", sessionsStatus)
	}
	if len(listSessionsResp.Sessions) == 0 {
		t.Fatalf("expected sessions in project")
	}

	var eventsResp struct {
		Events []model.SessionEvent `json:"events"`
	}
	eventsStatus := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v1/sessions/%s/events?after=0&limit=500", httpSrv.URL, sessionID),
		token,
		nil,
		&eventsResp,
	)
	if eventsStatus != http.StatusOK {
		t.Fatalf("session events status=%d want=200", eventsStatus)
	}
	seen := map[string]bool{}
	for _, event := range eventsResp.Events {
		seen[event.Type] = true
	}
	for _, typ := range []string{"run.started", "assistant.delta", "assistant.completed", "run.completed", "session.title.updated"} {
		if !seen[typ] {
			t.Fatalf("missing normalized event type %q in %#v", typ, seen)
		}
	}
}

func TestDeleteSessionRemovesRemoteCodexSessionAndLocalState(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_delete_1"
	project, err := srv.store.UpsertProject(model.ProjectRecord{
		ID:       "project_h1::/srv/work",
		HostID:   host.ID,
		HostName: host.Name,
		Path:     "/srv/work",
		Runtime:  "codex",
	})
	if err != nil {
		t.Fatalf("upsert project: %v", err)
	}
	if _, err := srv.store.UpsertSession(model.SessionRecord{
		ID:        sessionID,
		ProjectID: project.ID,
		HostID:    host.ID,
		Path:      "/srv/work",
		Runtime:   "codex",
		Title:     "Delete Target",
	}); err != nil {
		t.Fatalf("upsert session: %v", err)
	}
	if _, err := srv.store.AppendSessionEvent(model.SessionEvent{
		SessionID: sessionID,
		RunID:     "job_delete_1",
		Type:      "run.started",
		Payload:   json.RawMessage(`{"status":"running"}`),
	}); err != nil {
		t.Fatalf("append session event: %v", err)
	}

	runCalled := false
	srv.runViaSSH = func(_ context.Context, h model.Host, spec runtime.CommandSpec, _ string, _ executor.ExecOptions) (executor.ExecResult, error) {
		runCalled = true
		if h.ID != host.ID {
			t.Fatalf("delete host id=%q want=%q", h.ID, host.ID)
		}
		if spec.Program != "sh" {
			t.Fatalf("delete spec program=%q want=sh", spec.Program)
		}
		if len(spec.Args) < 2 || !strings.Contains(spec.Args[1], sessionID) {
			t.Fatalf("delete spec should include session id, args=%#v", spec.Args)
		}
		now := time.Now().UTC()
		return executor.ExecResult{
			ExitCode:   0,
			Stdout:     "/home/u/.codex/sessions/2026/03/04/rollout-2026-03-04T12-00-00-019cf300-1111-2222-3333-444455556666.jsonl\n",
			DurationMS: 3,
			StartedAt:  now,
			FinishedAt: now,
		}, nil
	}

	var deleteResp struct {
		Deleted bool                `json:"deleted"`
		Session model.SessionRecord `json:"session"`
		Remote  struct {
			PathCount int      `json:"path_count"`
			Paths     []string `json:"paths"`
		} `json:"remote"`
	}
	status := doJSON(
		t,
		httpSrv.Client(),
		http.MethodDelete,
		fmt.Sprintf("%s/v1/sessions/%s", httpSrv.URL, sessionID),
		token,
		nil,
		&deleteResp,
	)
	if status != http.StatusOK {
		t.Fatalf("delete session status=%d want=200", status)
	}
	if !runCalled {
		t.Fatalf("expected remote delete command to execute")
	}
	if !deleteResp.Deleted {
		t.Fatalf("deleted flag should be true")
	}
	if deleteResp.Session.ID != sessionID {
		t.Fatalf("deleted session id=%q want=%q", deleteResp.Session.ID, sessionID)
	}
	if deleteResp.Remote.PathCount != 1 || len(deleteResp.Remote.Paths) != 1 {
		t.Fatalf("unexpected delete paths: count=%d paths=%#v", deleteResp.Remote.PathCount, deleteResp.Remote.Paths)
	}
	if _, ok := srv.store.GetSession(sessionID); ok {
		t.Fatalf("session should be removed from store")
	}
	if events := srv.store.ListSessionEvents(sessionID, 0, 100); len(events) != 0 {
		t.Fatalf("session events should be removed, got=%d", len(events))
	}
}

func TestDeleteProjectRequiresEmptySessions(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()

	project, err := srv.store.UpsertProject(model.ProjectRecord{
		ID:       "project_h1::/srv/project-delete",
		HostID:   host.ID,
		HostName: host.Name,
		Path:     "/srv/project-delete",
		Runtime:  "codex",
	})
	if err != nil {
		t.Fatalf("upsert project: %v", err)
	}
	if _, err := srv.store.UpsertSession(model.SessionRecord{
		ID:        "session_project_delete_1",
		ProjectID: project.ID,
		HostID:    host.ID,
		Path:      "/srv/project-delete",
		Runtime:   "codex",
		Title:     "Delete blocker",
	}); err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	var blockedResp struct {
		Error        string              `json:"error"`
		Project      model.ProjectRecord `json:"project"`
		SessionCount int                 `json:"session_count"`
	}
	blockedStatus := doJSON(
		t,
		httpSrv.Client(),
		http.MethodDelete,
		fmt.Sprintf("%s/v1/projects/%s", httpSrv.URL, url.PathEscape(project.ID)),
		token,
		nil,
		&blockedResp,
	)
	if blockedStatus != http.StatusConflict {
		t.Fatalf("delete non-empty project status=%d want=409", blockedStatus)
	}
	if blockedResp.Error != "project is not empty" {
		t.Fatalf("error=%q want=project is not empty", blockedResp.Error)
	}
	if blockedResp.SessionCount != 1 {
		t.Fatalf("session_count=%d want=1", blockedResp.SessionCount)
	}
	if blockedResp.Project.ID != project.ID {
		t.Fatalf("project id=%q want=%q", blockedResp.Project.ID, project.ID)
	}

	if _, ok, err := srv.store.DeleteSession("session_project_delete_1"); err != nil || !ok {
		t.Fatalf("delete session err=%v ok=%v", err, ok)
	}

	var deleteResp struct {
		Deleted bool                `json:"deleted"`
		Project model.ProjectRecord `json:"project"`
	}
	deleteStatus := doJSON(
		t,
		httpSrv.Client(),
		http.MethodDelete,
		fmt.Sprintf("%s/v1/projects/%s", httpSrv.URL, url.PathEscape(project.ID)),
		token,
		nil,
		&deleteResp,
	)
	if deleteStatus != http.StatusOK {
		t.Fatalf("delete empty project status=%d want=200", deleteStatus)
	}
	if !deleteResp.Deleted {
		t.Fatalf("deleted should be true")
	}
	if deleteResp.Project.ID != project.ID {
		t.Fatalf("deleted project id=%q want=%q", deleteResp.Project.ID, project.ID)
	}

	var listResp struct {
		Projects []model.ProjectRecord `json:"projects"`
	}
	listStatus := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v1/projects?host_id=%s", httpSrv.URL, host.ID),
		token,
		nil,
		&listResp,
	)
	if listStatus != http.StatusOK {
		t.Fatalf("list projects status=%d want=200", listStatus)
	}
	if len(listResp.Projects) != 0 {
		t.Fatalf("projects should be empty after delete: %#v", listResp.Projects)
	}
}

func TestDiscoverCodexModels(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()

	srv.runViaSSH = func(_ context.Context, _ model.Host, spec runtime.CommandSpec, _ string, _ executor.ExecOptions) (executor.ExecResult, error) {
		now := time.Now().UTC()
		if spec.Program == "sh" {
			return executor.ExecResult{
				ExitCode:   0,
				Stdout:     `{"default_model":"gpt-5-codex","models":["gpt-5.3-codex","gpt-5-codex"]}` + "\n",
				DurationMS: 1,
				StartedAt:  now,
				FinishedAt: now,
			}, nil
		}
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
		"prompt":  "model check",
		"host_id": host.ID,
		"fanout":  1,
		"codex": map[string]any{
			"model": "gpt-5-mini",
		},
	}
	var enqueueResp struct {
		Job model.RunJobRecord `json:"job"`
	}
	status := doJSON(t, httpSrv.Client(), http.MethodPost, httpSrv.URL+"/v1/jobs/run", token, enqueueBody, &enqueueResp)
	if status != http.StatusAccepted {
		t.Fatalf("enqueue status=%d want=202", status)
	}
	_ = waitJobTerminal(t, httpSrv, token, enqueueResp.Job.ID, 3*time.Second)

	var modelResp codexModelsResponse
	modelStatus := doJSON(t, httpSrv.Client(), http.MethodGet, httpSrv.URL+"/v1/codex/models", token, nil, &modelResp)
	if modelStatus != http.StatusOK {
		t.Fatalf("model discover status=%d want=200", modelStatus)
	}
	if strings.TrimSpace(modelResp.DefaultModel) != "gpt-5-codex" {
		t.Fatalf("default_model=%q want=gpt-5-codex", modelResp.DefaultModel)
	}
	foundCatalog := false
	foundInjected := false
	for _, modelName := range modelResp.Models {
		if modelName == "gpt-5.3-codex" {
			foundCatalog = true
		}
		if modelName == "gpt-5-mini" {
			foundInjected = true
		}
	}
	if !foundCatalog {
		t.Fatalf("models should include discovered catalog gpt-5.3-codex: %#v", modelResp.Models)
	}
	if foundInjected {
		t.Fatalf("models should not include injected fallback/observed gpt-5-mini: %#v", modelResp.Models)
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

type sseMessage struct {
	ID    string
	Event string
	Data  string
}

func readSSEMessage(t *testing.T, reader *bufio.Reader, timeout time.Duration) sseMessage {
	t.Helper()
	type result struct {
		msg sseMessage
		err error
	}
	done := make(chan result, 1)
	go func() {
		var msg sseMessage
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				done <- result{err: err}
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				if msg.Event != "" || msg.Data != "" || msg.ID != "" {
					done <- result{msg: msg}
					return
				}
				continue
			}
			if strings.HasPrefix(line, ":") {
				continue
			}
			if strings.HasPrefix(line, "id:") {
				msg.ID = strings.TrimSpace(strings.TrimPrefix(line, "id:"))
				continue
			}
			if strings.HasPrefix(line, "event:") {
				msg.Event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
				continue
			}
			if strings.HasPrefix(line, "data:") {
				part := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				if msg.Data == "" {
					msg.Data = part
				} else {
					msg.Data += "\n" + part
				}
			}
		}
	}()
	select {
	case out := <-done:
		if out.err != nil {
			t.Fatalf("read sse message: %v", out.err)
		}
		return out.msg
	case <-time.After(timeout):
		t.Fatalf("timed out reading sse message")
		return sseMessage{}
	}
}
