package api

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

func TestPersistCodexNotificationDedupesEquivalentPayload(t *testing.T) {
	srv, httpSrv, _, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_codex_dedupe"
	upsertCodexTestSession(t, srv, sessionID)

	first := json.RawMessage(`{"thread_id":"session_codex_dedupe","turn":{"id":"turn_1","thread_id":"session_codex_dedupe"}}`)
	second := json.RawMessage(`{"turn":{"thread_id":"session_codex_dedupe","id":"turn_1"},"thread_id":"session_codex_dedupe"}`)

	now := time.Now().UTC()
	srv.persistCodexNotification("host_1", "turn/completed", first, now)
	srv.persistCodexNotification("host_1", "turn/completed", second, now.Add(150*time.Millisecond))

	events := srv.store.ListSessionEvents(sessionID, 0, 20)
	if len(events) != 1 {
		t.Fatalf("expected 1 deduped event, got=%d", len(events))
	}
	if events[0].Type != "run.completed" {
		t.Fatalf("unexpected event type: %q", events[0].Type)
	}
	if events[0].RunID != "turn_1" {
		t.Fatalf("unexpected run_id: %q", events[0].RunID)
	}
	var payload map[string]any
	if err := json.Unmarshal(events[0].Payload, &payload); err != nil {
		t.Fatalf("decode event payload: %v", err)
	}
	if turnID := asString(payload["turn_id"]); turnID != "turn_1" {
		t.Fatalf("payload turn_id=%q want=turn_1", turnID)
	}

	session, ok := srv.store.GetSession(sessionID)
	if !ok {
		t.Fatalf("session %q not found", sessionID)
	}
	if session.LastStatus != "succeeded" {
		t.Fatalf("session status=%q want=succeeded", session.LastStatus)
	}
	if session.LastRunID != "turn_1" {
		t.Fatalf("session last_run_id=%q want=turn_1", session.LastRunID)
	}
}

func TestPersistCodexNotificationKeepsDistinctPayloads(t *testing.T) {
	srv, httpSrv, _, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_codex_distinct"
	upsertCodexTestSession(t, srv, sessionID)

	first := json.RawMessage(`{"thread_id":"session_codex_distinct","turn_id":"turn_2","item":{"id":"item_1","type":"command_execution","status":"in_progress","command":"echo one"}}`)
	second := json.RawMessage(`{"thread_id":"session_codex_distinct","turn_id":"turn_2","item":{"id":"item_1","type":"command_execution","status":"completed","command":"echo one","exit_code":0}}`)

	now := time.Now().UTC()
	srv.persistCodexNotification("host_1", "item/updated", first, now)
	srv.persistCodexNotification("host_1", "item/completed", second, now.Add(120*time.Millisecond))

	events := srv.store.ListSessionEvents(sessionID, 0, 20)
	if len(events) != 2 {
		t.Fatalf("expected 2 distinct events, got=%d", len(events))
	}
	if events[0].RunID != "turn_2" || events[1].RunID != "turn_2" {
		t.Fatalf("unexpected run ids: first=%q second=%q", events[0].RunID, events[1].RunID)
	}
	if events[0].Type != "assistant.delta" || events[1].Type != "assistant.delta" {
		t.Fatalf("unexpected event types: first=%q second=%q", events[0].Type, events[1].Type)
	}
	var payload map[string]any
	if err := json.Unmarshal(events[0].Payload, &payload); err != nil {
		t.Fatalf("decode first payload: %v", err)
	}
	chunk := asString(payload["chunk"])
	if chunk == "" || !containsAll(chunk, `"type":"item.updated"`, `"turn_id":"turn_2"`) {
		t.Fatalf("unexpected first chunk payload: %q", chunk)
	}
}

func TestPersistCodexNotificationNormalizesThreadTitleEvents(t *testing.T) {
	srv, httpSrv, _, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_codex_title"
	upsertCodexTestSession(t, srv, sessionID)

	params := json.RawMessage(`{"thread":{"id":"session_codex_title","title":"  better title  "}}`)
	srv.persistCodexNotification("host_1", "thread/updated", params, time.Now().UTC())

	events := srv.store.ListSessionEvents(sessionID, 0, 20)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got=%d", len(events))
	}
	if events[0].Type != "session.title.updated" {
		t.Fatalf("unexpected event type: %q", events[0].Type)
	}
	var payload map[string]any
	if err := json.Unmarshal(events[0].Payload, &payload); err != nil {
		t.Fatalf("decode event payload: %v", err)
	}
	if title := asString(payload["title"]); title != "better title" {
		t.Fatalf("payload title=%q want=better title", title)
	}
}

func TestPendingRequestsClearedOnTurnTerminal(t *testing.T) {
	srv, httpSrv, _, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_pending_terminal"
	upsertCodexTestSession(t, srv, sessionID)
	srv.putCodexPendingRequest(codexPendingRequest{
		SessionID:  sessionID,
		RequestID:  "req_terminal_1",
		HostID:     "host_1",
		Method:     "approval/request",
		RawID:      json.RawMessage(`"req_terminal_1"`),
		Params:     json.RawMessage(`{"thread_id":"session_pending_terminal"}`),
		ReceivedAt: time.Now().UTC(),
	})

	pending := srv.listCodexPendingRequests(sessionID)
	if len(pending) != 1 {
		t.Fatalf("expected pending request before terminal event, got=%d", len(pending))
	}

	params := json.RawMessage(`{"thread_id":"session_pending_terminal","turn":{"id":"turn_term_1","thread_id":"session_pending_terminal"}}`)
	srv.persistCodexNotification("host_1", "turn/completed", params, time.Now().UTC())

	pending = srv.listCodexPendingRequests(sessionID)
	if len(pending) != 0 {
		t.Fatalf("expected pending requests to be cleared on terminal event, got=%d", len(pending))
	}
}

func TestListCodexPendingRequestsPrunesExpiredRecords(t *testing.T) {
	srv, httpSrv, _, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_pending_ttl"
	srv.mu.Lock()
	srv.codexPending[sessionID] = map[string]codexPendingRequest{
		"req_expired": {
			SessionID:  sessionID,
			RequestID:  "req_expired",
			HostID:     "host_1",
			Method:     "approval/request",
			ReceivedAt: time.Now().UTC().Add(-codexPendingTTL - 2*time.Minute),
		},
	}
	srv.mu.Unlock()

	items := srv.listCodexPendingRequests(sessionID)
	if len(items) != 0 {
		t.Fatalf("expected expired pending requests to be pruned, got=%d", len(items))
	}

	srv.mu.Lock()
	_, exists := srv.codexPending[sessionID]
	srv.mu.Unlock()
	if exists {
		t.Fatalf("expected empty pending session bucket to be removed")
	}
}

func TestExtractCodexResolvedRequestIDVariants(t *testing.T) {
	cases := []struct {
		name string
		raw  json.RawMessage
		want string
	}{
		{
			name: "request_id root",
			raw:  json.RawMessage(`{"request_id":"req_1"}`),
			want: "req_1",
		},
		{
			name: "requestId root",
			raw:  json.RawMessage(`{"requestId":"req_2"}`),
			want: "req_2",
		},
		{
			name: "id root",
			raw:  json.RawMessage(`{"id":"req_3"}`),
			want: "req_3",
		},
		{
			name: "request nested",
			raw:  json.RawMessage(`{"request":{"id":"req_4"}}`),
			want: "req_4",
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got := extractCodexResolvedRequestID(tc.raw)
			if got != tc.want {
				t.Fatalf("request id=%q want=%q", got, tc.want)
			}
		})
	}
}

func upsertCodexTestSession(t *testing.T, srv *Server, sessionID string) {
	t.Helper()
	_, err := srv.store.UpsertSession(model.SessionRecord{
		ID:        sessionID,
		ProjectID: "project_test",
		HostID:    "host_test",
		Path:      "/tmp",
		Runtime:   "codex",
		Title:     "test",
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}
}

func containsAll(body string, parts ...string) bool {
	for _, part := range parts {
		if !strings.Contains(body, part) {
			return false
		}
	}
	return true
}
