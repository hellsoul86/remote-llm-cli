package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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
