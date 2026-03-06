package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

func TestCodexV2WSStreamResumesFromAfterCursor(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_ws_resume"
	upsertCodexTestSession(t, srv, sessionID)

	first := appendSessionEventForTest(t, srv, sessionID, "run.started", "turn_ws_1", map[string]any{
		"turn_id": "turn_ws_1",
	})
	second := appendSessionEventForTest(t, srv, sessionID, "assistant.delta", "turn_ws_1", map[string]any{
		"chunk": "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"ws hello\"}}\n",
	})

	conn := dialCodexSessionWS(t, httpSrv.URL, token, sessionID, first.Seq)
	defer conn.Close()

	eventFrame := readWSFrameType(t, conn, "session.event", 2*time.Second)
	if id := strings.TrimSpace(asString(eventFrame["id"])); id != strconv.FormatInt(second.Seq, 10) {
		t.Fatalf("event id=%q want=%d", id, second.Seq)
	}
	eventObj, ok := eventFrame["event"].(map[string]any)
	if !ok {
		t.Fatalf("event payload missing: %#v", eventFrame)
	}
	if seq := asInt64(eventObj["seq"]); seq != second.Seq {
		t.Fatalf("event seq=%d want=%d", seq, second.Seq)
	}

	readyFrame := readWSFrameType(t, conn, "session.ready", 2*time.Second)
	if cursor := asInt64(readyFrame["cursor"]); cursor != second.Seq {
		t.Fatalf("ready cursor=%d want=%d", cursor, second.Seq)
	}
}

func TestCodexV2WSStreamReceivesLivePublish(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_ws_live"
	upsertCodexTestSession(t, srv, sessionID)

	base := appendSessionEventForTest(t, srv, sessionID, "run.started", "turn_ws_live", map[string]any{
		"turn_id": "turn_ws_live",
	})

	conn := dialCodexSessionWS(t, httpSrv.URL, token, sessionID, base.Seq)
	defer conn.Close()

	readyFrame := readWSFrameType(t, conn, "session.ready", 2*time.Second)
	if cursor := asInt64(readyFrame["cursor"]); cursor != base.Seq {
		t.Fatalf("ready cursor=%d want=%d", cursor, base.Seq)
	}

	live := appendSessionEventForTest(t, srv, sessionID, "run.completed", "turn_ws_live", map[string]any{
		"turn_id": "turn_ws_live",
	})
	srv.publishSessionEvent(live)

	eventFrame := readWSFrameType(t, conn, "session.event", 2*time.Second)
	if id := strings.TrimSpace(asString(eventFrame["id"])); id != strconv.FormatInt(live.Seq, 10) {
		t.Fatalf("event id=%q want=%d", id, live.Seq)
	}
	eventObj, ok := eventFrame["event"].(map[string]any)
	if !ok {
		t.Fatalf("event payload missing: %#v", eventFrame)
	}
	if seq := asInt64(eventObj["seq"]); seq != live.Seq {
		t.Fatalf("event seq=%d want=%d", seq, live.Seq)
	}
}

func TestCodexV2WSReconnectAfterLatestCursorDoesNotReplay(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_ws_reconnect"
	upsertCodexTestSession(t, srv, sessionID)

	first := appendSessionEventForTest(t, srv, sessionID, "run.started", "turn_ws_r1", map[string]any{
		"turn_id": "turn_ws_r1",
	})
	second := appendSessionEventForTest(t, srv, sessionID, "run.completed", "turn_ws_r1", map[string]any{
		"turn_id": "turn_ws_r1",
	})

	conn := dialCodexSessionWS(t, httpSrv.URL, token, sessionID, 0)
	_ = readWSFrameType(t, conn, "session.event", 2*time.Second)
	_ = readWSFrameType(t, conn, "session.event", 2*time.Second)
	readyFrame := readWSFrameType(t, conn, "session.ready", 2*time.Second)
	if cursor := asInt64(readyFrame["cursor"]); cursor != second.Seq {
		t.Fatalf("ready cursor=%d want=%d", cursor, second.Seq)
	}
	_ = conn.Close()

	reconn := dialCodexSessionWS(t, httpSrv.URL, token, sessionID, second.Seq)
	defer reconn.Close()
	reconnReady := readWSFrameType(t, reconn, "session.ready", 2*time.Second)
	if cursor := asInt64(reconnReady["cursor"]); cursor != second.Seq {
		t.Fatalf("reconnect ready cursor=%d want=%d", cursor, second.Seq)
	}

	reconn.SetReadDeadline(time.Now().Add(320 * time.Millisecond))
	if _, _, err := reconn.ReadMessage(); err == nil {
		t.Fatalf("expected no replay frame after latest cursor")
	} else {
		var netErr net.Error
		if !errors.As(err, &netErr) || !netErr.Timeout() {
			t.Fatalf("expected read timeout without replay frame, got=%v", err)
		}
	}

	if first.Seq != 1 {
		t.Fatalf("sanity: first seq=%d want=1", first.Seq)
	}
}

func TestCodexV2WSStreamEmitsResetWhenSubscriptionCloses(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const sessionID = "session_ws_reset"
	upsertCodexTestSession(t, srv, sessionID)

	conn := dialCodexSessionWS(t, httpSrv.URL, token, sessionID, 0)
	defer conn.Close()

	readyFrame := readWSFrameType(t, conn, "session.ready", 2*time.Second)
	if cursor := asInt64(readyFrame["cursor"]); cursor != 0 {
		t.Fatalf("ready cursor=%d want=0", cursor)
	}

	forceCloseSessionSubscriptions(srv, sessionID)

	resetFrame := readWSFrameType(t, conn, "session.reset", 2*time.Second)
	if reason := strings.TrimSpace(asString(resetFrame["reason"])); reason != "backpressure" {
		t.Fatalf("reset reason=%q want=backpressure", reason)
	}
}

func TestCodexV2WSReplayAndLiveInterleavingKeepsOrderedUniqueEvents(t *testing.T) {
	srv, httpSrv, token, _ := newAuthedTestServer(t)
	defer httpSrv.Close()

	const (
		sessionID    = "session_ws_interleaved_ordering"
		replayEvents = 320
		liveEvents   = 40
	)
	upsertCodexTestSession(t, srv, sessionID)

	var seededLast int64
	for i := 0; i < replayEvents; i++ {
		event := appendSessionEventForTest(t, srv, sessionID, "assistant.delta", "turn_ws_interleave", map[string]any{
			"chunk": fmt.Sprintf("{\"type\":\"item.updated\",\"seq\":%d}\n", i+1),
		})
		seededLast = event.Seq
	}
	if seededLast <= 0 {
		t.Fatalf("expected seeded events")
	}

	conn := dialCodexSessionWS(t, httpSrv.URL, token, sessionID, 0)
	defer conn.Close()

	liveFinalCh := make(chan int64, 1)
	go func() {
		time.Sleep(15 * time.Millisecond)
		last := int64(0)
		for i := 0; i < liveEvents; i++ {
			event := appendSessionEventForTest(t, srv, sessionID, "assistant.delta", "turn_ws_interleave", map[string]any{
				"chunk": fmt.Sprintf("{\"type\":\"item.updated\",\"live\":%d}\n", i+1),
			})
			srv.publishSessionEvent(event)
			last = event.Seq
			time.Sleep(2 * time.Millisecond)
		}
		liveFinalCh <- last
	}()

	seen := map[int64]struct{}{}
	lastSeq := int64(0)
	liveFinal := int64(0)
	readySeen := false
	liveDone := false

	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if !liveDone {
			select {
			case liveFinal = <-liveFinalCh:
				liveDone = true
			default:
			}
		}

		_ = conn.SetReadDeadline(time.Now().Add(800 * time.Millisecond))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				if readySeen && liveDone && lastSeq >= liveFinal && liveFinal > 0 {
					break
				}
				continue
			}
			t.Fatalf("read ws frame: %v", err)
		}

		var frame map[string]any
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatalf("decode ws frame: %v raw=%q", err, string(raw))
		}
		switch strings.TrimSpace(asString(frame["type"])) {
		case "session.ready":
			readySeen = true
		case "session.event":
			eventObj, ok := frame["event"].(map[string]any)
			if !ok {
				t.Fatalf("event payload missing: %#v", frame)
			}
			seq := asInt64(eventObj["seq"])
			if seq <= 0 {
				t.Fatalf("invalid seq: %d", seq)
			}
			if seq <= lastSeq {
				t.Fatalf("non-monotonic seq: got=%d last=%d", seq, lastSeq)
			}
			if _, exists := seen[seq]; exists {
				t.Fatalf("duplicate seq received: %d", seq)
			}
			seen[seq] = struct{}{}
			lastSeq = seq
		}

		if readySeen && liveDone && lastSeq >= liveFinal && liveFinal > 0 {
			break
		}
	}

	if !readySeen {
		t.Fatalf("session.ready frame not observed")
	}
	if !liveDone || liveFinal == 0 {
		t.Fatalf("live publish did not complete")
	}
	if lastSeq < liveFinal {
		t.Fatalf("last seq=%d want >= live final=%d", lastSeq, liveFinal)
	}
	for seq := int64(1); seq <= liveFinal; seq++ {
		if _, ok := seen[seq]; !ok {
			t.Fatalf("missing seq=%d in replay/live stream", seq)
		}
	}
}

func appendSessionEventForTest(
	t *testing.T,
	srv *Server,
	sessionID string,
	eventType string,
	runID string,
	payload map[string]any,
) model.SessionEvent {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal session payload: %v", err)
	}
	event, err := srv.store.AppendSessionEvent(model.SessionEvent{
		SessionID: sessionID,
		RunID:     runID,
		Type:      eventType,
		Payload:   raw,
		CreatedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("append session event: %v", err)
	}
	return event
}

func dialCodexSessionWS(
	t *testing.T,
	baseHTTPURL string,
	token string,
	sessionID string,
	after int64,
) *websocket.Conn {
	t.Helper()
	base, err := url.Parse(baseHTTPURL)
	if err != nil {
		t.Fatalf("parse base url: %v", err)
	}
	wsScheme := "ws"
	if strings.EqualFold(base.Scheme, "https") {
		wsScheme = "wss"
	}
	wsURL := url.URL{
		Scheme: wsScheme,
		Host:   base.Host,
		Path:   fmt.Sprintf("/v2/codex/sessions/%s/ws", sessionID),
	}
	query := wsURL.Query()
	query.Set("access_token", token)
	if after > 0 {
		query.Set("after", strconv.FormatInt(after, 10))
	}
	wsURL.RawQuery = query.Encode()

	conn, res, err := websocket.DefaultDialer.Dial(wsURL.String(), nil)
	if err != nil {
		body := ""
		if res != nil {
			raw, _ := io.ReadAll(res.Body)
			_ = res.Body.Close()
			body = string(raw)
		}
		t.Fatalf("dial ws: %v body=%q", err, body)
	}
	return conn
}

func readWSFrameType(
	t *testing.T,
	conn *websocket.Conn,
	wantType string,
	timeout time.Duration,
) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		perRead := remaining
		if perRead > 900*time.Millisecond {
			perRead = 900 * time.Millisecond
		}
		frame := readWSFrame(t, conn, perRead)
		if strings.TrimSpace(asString(frame["type"])) == wantType {
			return frame
		}
	}
	t.Fatalf("timed out waiting ws frame type=%q", wantType)
	return nil
}

func readWSFrame(t *testing.T, conn *websocket.Conn, timeout time.Duration) map[string]any {
	t.Helper()
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read ws frame: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode ws frame: %v raw=%q", err, string(raw))
	}
	return payload
}

func asInt64(v any) int64 {
	switch value := v.(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	case json.Number:
		out, _ := value.Int64()
		return out
	default:
		return 0
	}
}

func forceCloseSessionSubscriptions(s *Server, sessionID string) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	s.mu.Lock()
	bySession := s.streamSubs[sessionID]
	if len(bySession) == 0 {
		s.mu.Unlock()
		return
	}
	channels := make([]chan model.SessionEvent, 0, len(bySession))
	for _, ch := range bySession {
		channels = append(channels, ch)
	}
	delete(s.streamSubs, sessionID)
	s.mu.Unlock()

	for _, ch := range channels {
		close(ch)
	}
}
