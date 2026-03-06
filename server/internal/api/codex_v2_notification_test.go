package api

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/codexrpc"
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

func TestPersistCodexNotificationNormalizesOfficialThreadNameUpdate(t *testing.T) {
	srv, httpSrv, _, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_codex_thread_name"
	upsertCodexTestSession(t, srv, sessionID)

	params := json.RawMessage(`{"threadId":"session_codex_thread_name","threadName":"  official title  "}`)
	srv.persistCodexNotification("host_1", "thread/name/updated", params, time.Now().UTC())

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
	if title := asString(payload["title"]); title != "official title" {
		t.Fatalf("payload title=%q want=official title", title)
	}
}

func TestPersistCodexNotificationNormalizesRunLifecycleEvents(t *testing.T) {
	srv, httpSrv, _, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	testCases := []struct {
		name        string
		sessionID   string
		method      string
		raw         string
		wantType    string
		wantStatus  string
		wantRunID   string
		wantErrPart string
	}{
		{
			name:       "turn started",
			sessionID:  "session_codex_turn_started",
			method:     "turn/started",
			raw:        `{"threadId":"session_codex_turn_started","turn":{"id":"turn_started_1","threadId":"session_codex_turn_started"}}`,
			wantType:   "run.started",
			wantStatus: "running",
			wantRunID:  "turn_started_1",
		},
		{
			name:       "turn interrupted",
			sessionID:  "session_codex_turn_interrupted",
			method:     "turn/interrupted",
			raw:        `{"threadId":"session_codex_turn_interrupted","turn":{"id":"turn_interrupted_1","threadId":"session_codex_turn_interrupted"}}`,
			wantType:   "run.canceled",
			wantStatus: "canceled",
			wantRunID:  "turn_interrupted_1",
		},
		{
			name:        "error",
			sessionID:   "session_codex_error",
			method:      "error",
			raw:         `{"threadId":"session_codex_error","turnId":"turn_error_1","error":{"message":"boom"},"willRetry":false}`,
			wantType:    "run.failed",
			wantStatus:  "",
			wantRunID:   "turn_error_1",
			wantErrPart: "boom",
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			upsertCodexTestSession(t, srv, tc.sessionID)
			srv.persistCodexNotification("host_1", tc.method, json.RawMessage(tc.raw), time.Now().UTC())

			events := srv.store.ListSessionEvents(tc.sessionID, 0, 20)
			if len(events) != 1 {
				t.Fatalf("expected 1 event, got=%d", len(events))
			}
			if events[0].Type != tc.wantType {
				t.Fatalf("event type=%q want=%q", events[0].Type, tc.wantType)
			}
			if events[0].RunID != tc.wantRunID {
				t.Fatalf("run_id=%q want=%q", events[0].RunID, tc.wantRunID)
			}

			var payload map[string]any
			if err := json.Unmarshal(events[0].Payload, &payload); err != nil {
				t.Fatalf("decode event payload: %v", err)
			}
			if turnID := asString(payload["turn_id"]); turnID != tc.wantRunID {
				t.Fatalf("payload turn_id=%q want=%q", turnID, tc.wantRunID)
			}
			if tc.wantErrPart != "" {
				rawErr, err := json.Marshal(payload["error"])
				if err != nil {
					t.Fatalf("marshal payload error: %v", err)
				}
				if !strings.Contains(string(rawErr), tc.wantErrPart) {
					t.Fatalf("payload error=%s want part=%q", string(rawErr), tc.wantErrPart)
				}
			}

			session, ok := srv.store.GetSession(tc.sessionID)
			if !ok {
				t.Fatalf("session %q not found", tc.sessionID)
			}
			if tc.wantStatus != "" && session.LastStatus != tc.wantStatus {
				t.Fatalf("session status=%q want=%q", session.LastStatus, tc.wantStatus)
			}
			if tc.wantStatus != "" && session.LastRunID != tc.wantRunID {
				t.Fatalf("session last_run_id=%q want=%q", session.LastRunID, tc.wantRunID)
			}
		})
	}
}

func TestPersistCodexNotificationNormalizesItemStarted(t *testing.T) {
	srv, httpSrv, _, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_codex_item_started"
	upsertCodexTestSession(t, srv, sessionID)

	params := json.RawMessage(`{"threadId":"session_codex_item_started","turnId":"turn_item_1","item":{"id":"item_1","type":"agent_message","status":"in_progress"}}`)
	srv.persistCodexNotification("host_1", "item/started", params, time.Now().UTC())

	events := srv.store.ListSessionEvents(sessionID, 0, 20)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got=%d", len(events))
	}
	if events[0].Type != "assistant.delta" {
		t.Fatalf("unexpected event type: %q", events[0].Type)
	}
	var payload map[string]any
	if err := json.Unmarshal(events[0].Payload, &payload); err != nil {
		t.Fatalf("decode event payload: %v", err)
	}
	chunk := asString(payload["chunk"])
	if chunk == "" || !containsAll(chunk, `"type":"item.started"`, `"turnId":"turn_item_1"`) {
		t.Fatalf("unexpected chunk=%q", chunk)
	}
}

func TestPersistCodexServerRequestLifecycleTracksCriticalMethods(t *testing.T) {
	srv, httpSrv, _, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	testCases := []struct {
		name      string
		sessionID string
		method    string
		params    string
	}{
		{
			name:      "command approval",
			sessionID: "session_codex_pending_1",
			method:    "item/commandExecution/requestApproval",
			params:    `{"threadId":"session_codex_pending_1","command":"ls -la","availableDecisions":["accept","decline"]}`,
		},
		{
			name:      "file approval",
			sessionID: "session_codex_pending_2",
			method:    "item/fileChange/requestApproval",
			params:    `{"threadId":"session_codex_pending_2","grantRoot":"/tmp","availableDecisions":["accept","acceptForSession","decline"]}`,
		},
		{
			name:      "tool input",
			sessionID: "session_codex_pending_3",
			method:    "item/tool/requestUserInput",
			params:    `{"threadId":"session_codex_pending_3","questions":[{"id":"q1","header":"Name","question":"Who?"}]}`,
		},
		{
			name:      "mcp elicitation",
			sessionID: "session_codex_pending_4",
			method:    "mcpServer/elicitation/request",
			params:    `{"threadId":"session_codex_pending_4","serverName":"github","mode":"form","requestedSchema":{"type":"object","properties":{"repo":{"type":"string"}},"required":["repo"]}}`,
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			upsertCodexTestSession(t, srv, tc.sessionID)

			req := codexrpc.ServerRequest{
				ID:         "req_" + strings.ReplaceAll(tc.method, "/", "_"),
				Method:     tc.method,
				RawID:      json.RawMessage(`"req_test"`),
				Params:     json.RawMessage(tc.params),
				ReceivedAt: time.Now().UTC(),
			}
			srv.persistCodexServerRequest("host_1", req)

			pending := srv.listCodexPendingRequests(tc.sessionID)
			if len(pending) != 1 {
				t.Fatalf("expected 1 pending request, got=%d", len(pending))
			}
			if pending[0].Method != tc.method {
				t.Fatalf("pending method=%q want=%q", pending[0].Method, tc.method)
			}

			events := srv.store.ListSessionEvents(tc.sessionID, 0, 20)
			if len(events) != 1 {
				t.Fatalf("expected 1 session event, got=%d", len(events))
			}
			if events[0].Type != "codexrpc.serverRequest."+strings.ReplaceAll(tc.method, "/", ".") {
				t.Fatalf("event type=%q", events[0].Type)
			}

			resolved := json.RawMessage(fmt.Sprintf(`{"threadId":%q,"requestId":%q}`, tc.sessionID, req.ID))
			srv.persistCodexNotification("host_1", "serverRequest/resolved", resolved, time.Now().UTC())

			pending = srv.listCodexPendingRequests(tc.sessionID)
			if len(pending) != 0 {
				t.Fatalf("expected pending requests to be cleared, got=%d", len(pending))
			}
		})
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
