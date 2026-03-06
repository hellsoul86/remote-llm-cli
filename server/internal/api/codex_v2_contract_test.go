package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

func TestCodexV2SessionEventsContractShape(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_contract_events_v2"
	upsertCodexTestSession(t, srv, sessionID)

	first := appendSessionEventForTest(t, srv, sessionID, "run.started", "turn_contract_1", map[string]any{
		"turn_id": "turn_contract_1",
	})
	_ = appendSessionEventForTest(t, srv, sessionID, "run.completed", "turn_contract_1", map[string]any{
		"turn_id": "turn_contract_1",
	})

	var resp struct {
		SessionID  string               `json:"session_id"`
		After      int64                `json:"after"`
		NextAfter  int64                `json:"next_after"`
		EventCount int                  `json:"event_count"`
		Events     []model.SessionEvent `json:"events"`
	}
	status := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v2/codex/sessions/%s/events?after=%d&limit=200", httpSrv.URL, sessionID, first.Seq),
		token,
		nil,
		&resp,
	)
	if status != http.StatusOK {
		t.Fatalf("status=%d want=200", status)
	}
	if resp.SessionID != sessionID {
		t.Fatalf("session_id=%q want=%q", resp.SessionID, sessionID)
	}
	if resp.After != first.Seq {
		t.Fatalf("after=%d want=%d", resp.After, first.Seq)
	}
	if resp.EventCount != 1 || len(resp.Events) != 1 {
		t.Fatalf("event count mismatch: event_count=%d len=%d", resp.EventCount, len(resp.Events))
	}
	if resp.NextAfter != resp.Events[0].Seq {
		t.Fatalf("next_after=%d want=%d", resp.NextAfter, resp.Events[0].Seq)
	}
}

func TestCodexV2PendingRequestsContractShape(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_contract_pending_v2"
	upsertCodexTestSession(t, srv, sessionID)
	srv.putCodexPendingRequest(codexPendingRequest{
		SessionID:  sessionID,
		RequestID:  "req_contract_1",
		HostID:     "host_1",
		Method:     "approval/request",
		RawID:      json.RawMessage(`"req_contract_1"`),
		Params:     json.RawMessage(`{"thread_id":"session_contract_pending_v2"}`),
		ReceivedAt: time.Now().UTC(),
	})

	var resp struct {
		SessionID string                `json:"session_id"`
		Requests  []codexPendingRequest `json:"requests"`
	}
	status := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v2/codex/sessions/%s/requests/pending", httpSrv.URL, sessionID),
		token,
		nil,
		&resp,
	)
	if status != http.StatusOK {
		t.Fatalf("status=%d want=200", status)
	}
	if resp.SessionID != sessionID {
		t.Fatalf("session_id=%q want=%q", resp.SessionID, sessionID)
	}
	if len(resp.Requests) != 1 {
		t.Fatalf("pending requests=%d want=1", len(resp.Requests))
	}
	if resp.Requests[0].RequestID != "req_contract_1" {
		t.Fatalf("request_id=%q want=req_contract_1", resp.Requests[0].RequestID)
	}
}

func TestCodexV2PendingRequestsContractUsesEmptyArrayWhenIdle(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_contract_pending_empty_v2"
	upsertCodexTestSession(t, srv, sessionID)

	req, err := http.NewRequest(
		http.MethodGet,
		fmt.Sprintf("%s/v2/codex/sessions/%s/requests/pending", httpSrv.URL, sessionID),
		nil,
	)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	res, err := httpSrv.Client().Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want=200", res.StatusCode)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if !strings.Contains(string(body), `"requests":[]`) {
		t.Fatalf("body=%s want requests as []", string(body))
	}
}

func TestCodexV2RequestParamNormalizationUsesCLIEnumSpellings(t *testing.T) {
	sessionParams := codexV2SessionParams{
		model:          "gpt-5.3-codex",
		approvalPolicy: "onRequest",
		sandbox:        "workspaceWrite",
		cwd:            "/tmp/project",
	}.ToMap(true)
	if got := sessionParams["approvalPolicy"]; got != "on-request" {
		t.Fatalf("session approvalPolicy=%v want=on-request", got)
	}
	if got := sessionParams["sandbox"]; got != "workspace-write" {
		t.Fatalf("session sandbox=%v want=workspace-write", got)
	}
	if got := sessionParams["cwd"]; got != "/tmp/project" {
		t.Fatalf("session cwd=%v want=/tmp/project", got)
	}

	if got := normalizeCodexV2Approval("onFailure"); got != "on-failure" {
		t.Fatalf("normalize approval onFailure=%q want=on-failure", got)
	}
	if got := normalizeCodexV2Approval("on-request"); got != "on-request" {
		t.Fatalf("normalize approval on-request=%q want=on-request", got)
	}
	if got := normalizeCodexV2Sandbox("readOnly"); got != "read-only" {
		t.Fatalf("normalize sandbox readOnly=%q want=read-only", got)
	}
	if got := normalizeCodexV2Sandbox("danger-full-access"); got != "danger-full-access" {
		t.Fatalf("normalize sandbox danger-full-access=%q want=danger-full-access", got)
	}
}

func TestCodexV2SessionStreamResumesFromLastEventID(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_contract_stream_v2"
	upsertCodexTestSession(t, srv, sessionID)

	first := appendSessionEventForTest(t, srv, sessionID, "run.started", "turn_contract_s1", map[string]any{
		"turn_id": "turn_contract_s1",
	})
	second := appendSessionEventForTest(t, srv, sessionID, "assistant.delta", "turn_contract_s1", map[string]any{
		"chunk": "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"contract\"}}\n",
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		fmt.Sprintf("%s/v2/codex/sessions/%s/stream", httpSrv.URL, sessionID),
		nil,
	)
	if err != nil {
		t.Fatalf("new stream request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Last-Event-ID", fmt.Sprintf("%d", first.Seq))
	res, err := httpSrv.Client().Do(req)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("stream status=%d want=200", res.StatusCode)
	}

	reader := bufio.NewReader(res.Body)
	frame := readSSEMessage(t, reader, 2*time.Second)
	if frame.Event != "session.event" {
		t.Fatalf("event=%q want=session.event payload=%q", frame.Event, frame.Data)
	}
	if frame.ID != fmt.Sprintf("%d", second.Seq) {
		t.Fatalf("event id=%q want=%d", frame.ID, second.Seq)
	}
}

func TestCodexV2EventsRequireBearerToken(t *testing.T) {
	srv, httpSrv, _, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_contract_auth_v2"
	upsertCodexTestSession(t, srv, sessionID)

	var resp struct {
		Error string `json:"error"`
	}
	status := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v2/codex/sessions/%s/events", httpSrv.URL, sessionID),
		"",
		nil,
		&resp,
	)
	if status != http.StatusUnauthorized {
		t.Fatalf("status=%d want=401", status)
	}
	if resp.Error != "missing bearer token" {
		t.Fatalf("error=%q want=missing bearer token", resp.Error)
	}
}

func TestCodexV2EventsRejectInvalidAfterCursor(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_contract_invalid_after_v2"
	upsertCodexTestSession(t, srv, sessionID)

	var resp struct {
		Error string `json:"error"`
	}
	status := doJSON(
		t,
		httpSrv.Client(),
		http.MethodGet,
		fmt.Sprintf("%s/v2/codex/sessions/%s/events?after=-1", httpSrv.URL, sessionID),
		token,
		nil,
		&resp,
	)
	if status != http.StatusBadRequest {
		t.Fatalf("status=%d want=400", status)
	}
	if resp.Error != "invalid after" {
		t.Fatalf("error=%q want=invalid after", resp.Error)
	}
}

func TestCodexV2TurnStartRequiresPromptOrInput(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_contract_turn_validation_v2"
	_, err := srv.store.UpsertSession(model.SessionRecord{
		ID:        sessionID,
		HostID:    host.ID,
		Path:      "/tmp",
		Runtime:   "codex",
		ProjectID: "project_test",
		Title:     "turn validation",
	})
	if err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	var resp struct {
		Error string `json:"error"`
	}
	status := doJSON(
		t,
		httpSrv.Client(),
		http.MethodPost,
		fmt.Sprintf("%s/v2/codex/sessions/%s/turns/start", httpSrv.URL, sessionID),
		token,
		map[string]any{
			"host_id": host.ID,
		},
		&resp,
	)
	if status != http.StatusBadRequest {
		t.Fatalf("status=%d want=400", status)
	}
	if resp.Error != "prompt or input is required" {
		t.Fatalf("error=%q want=prompt or input is required", resp.Error)
	}
}

func TestCodexV2ResolveRequestMissingRecord(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_contract_missing_pending_v2"
	upsertCodexTestSession(t, srv, sessionID)

	var resp struct {
		Error string `json:"error"`
	}
	status := doJSON(
		t,
		httpSrv.Client(),
		http.MethodPost,
		fmt.Sprintf("%s/v2/codex/sessions/%s/requests/req_missing/resolve", httpSrv.URL, sessionID),
		token,
		map[string]any{},
		&resp,
	)
	if status != http.StatusNotFound {
		t.Fatalf("status=%d want=404", status)
	}
	if resp.Error != "pending request not found" {
		t.Fatalf("error=%q want=pending request not found", resp.Error)
	}
}
