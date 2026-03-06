package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var codexV2WSUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(_ *http.Request) bool {
		return true
	},
}

const codexV2WSReadLimitBytes = 16 * 1024 * 1024

func (s *Server) handleCodexV2SessionEvents(w http.ResponseWriter, r *http.Request) {
	s.handleListSessionEvents(w, r)
}

func (s *Server) handleCodexV2SessionStream(w http.ResponseWriter, r *http.Request) {
	s.handleStreamSessionEvents(w, r)
}

func (s *Server) handleCodexV2SessionWS(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("id"))
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session id"})
		return
	}
	if _, ok := s.store.GetSession(sessionID); !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "session not found"})
		return
	}

	var after int64
	if raw := strings.TrimSpace(r.URL.Query().Get("after")); raw != "" {
		parsed, err := parseCursor(raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid after cursor"})
			return
		}
		after = parsed
	}

	conn, err := codexV2WSUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	conn.SetReadLimit(codexV2WSReadLimitBytes)
	_ = conn.SetReadDeadline(time.Now().Add(65 * time.Second))
	conn.SetPongHandler(func(_ string) error {
		return conn.SetReadDeadline(time.Now().Add(65 * time.Second))
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	streamCh, unsubscribe := s.subscribeSessionStream(sessionID, sessionStreamBuffer)
	defer unsubscribe()

	lastSeq := after
	for {
		events := s.store.ListSessionEvents(sessionID, lastSeq, sessionStreamBatch)
		if len(events) == 0 {
			break
		}
		for _, event := range events {
			if event.Seq <= lastSeq {
				continue
			}
			if err := writeWSFrame(conn, map[string]any{
				"type":  "session.event",
				"id":    strconv.FormatInt(event.Seq, 10),
				"event": event,
			}); err != nil {
				return
			}
			lastSeq = event.Seq
		}
		if len(events) < sessionStreamBatch {
			break
		}
	}

	if err := writeWSFrame(conn, map[string]any{
		"type":       "session.ready",
		"session_id": sessionID,
		"cursor":     lastSeq,
	}); err != nil {
		return
	}

	pingTicker := time.NewTicker(25 * time.Second)
	defer pingTicker.Stop()
	hbTicker := time.NewTicker(sessionStreamHB)
	defer hbTicker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-done:
			return
		case <-pingTicker.C:
			if err := conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(5*time.Second)); err != nil {
				return
			}
		case now := <-hbTicker.C:
			if err := writeWSFrame(conn, map[string]any{
				"type":       "heartbeat",
				"session_id": sessionID,
				"cursor":     lastSeq,
				"timestamp":  now.UTC(),
			}); err != nil {
				return
			}
		case event, ok := <-streamCh:
			if !ok {
				_ = writeWSFrame(conn, map[string]any{
					"type":       "session.reset",
					"session_id": sessionID,
					"reason":     "backpressure",
					"next_after": lastSeq,
				})
				return
			}
			if event.Seq <= lastSeq {
				continue
			}
			if err := writeWSFrame(conn, map[string]any{
				"type":  "session.event",
				"id":    strconv.FormatInt(event.Seq, 10),
				"event": event,
			}); err != nil {
				return
			}
			lastSeq = event.Seq
		}
	}
}

func writeWSFrame(conn *websocket.Conn, payload any) error {
	if conn == nil {
		return errors.New("nil websocket connection")
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, raw)
}
