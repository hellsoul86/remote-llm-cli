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
