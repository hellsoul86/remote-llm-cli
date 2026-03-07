package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hellsoul86/remote-llm-cli/server/internal/executor"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

const (
	projectTerminalFrameBacklog = 4096
	projectTerminalSubBuffer    = 256
)

type projectTerminalFrame struct {
	Seq       int64     `json:"seq"`
	Type      string    `json:"type"`
	Stream    string    `json:"stream,omitempty"`
	Data      string    `json:"data,omitempty"`
	ExitCode  int       `json:"exit_code,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

type projectTerminalSnapshot struct {
	ID        string     `json:"id"`
	ProjectID string     `json:"project_id"`
	HostID    string     `json:"host_id"`
	Workdir   string     `json:"workdir"`
	Command   string     `json:"command,omitempty"`
	State     string     `json:"state"`
	Cursor    int64      `json:"cursor"`
	StartedAt time.Time  `json:"started_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	ExitCode  *int       `json:"exit_code,omitempty"`
	ClosedAt  *time.Time `json:"closed_at,omitempty"`
}

type projectTerminalSession struct {
	id        string
	projectID string
	hostID    string
	workdir   string
	command   string
	proc      *executor.InteractiveProcess
	startedAt time.Time
	updatedAt time.Time
	closedAt  *time.Time
	exitCode  *int
	closed    bool

	mu        sync.Mutex
	seq       int64
	nextSubID int64
	frames    []projectTerminalFrame
	subs      map[int64]chan projectTerminalFrame
}

func newProjectTerminalSession(project model.ProjectRecord, host model.Host, proc *executor.InteractiveProcess) *projectTerminalSession {
	now := time.Now().UTC()
	return &projectTerminalSession{
		id:        "term_" + strings.TrimSpace(project.ID),
		projectID: strings.TrimSpace(project.ID),
		hostID:    strings.TrimSpace(host.ID),
		workdir:   strings.TrimSpace(project.Path),
		command:   strings.TrimSpace(proc.CommandLine()),
		proc:      proc,
		startedAt: now,
		updatedAt: now,
		subs:      map[int64]chan projectTerminalFrame{},
		frames:    []projectTerminalFrame{},
	}
}

func (t *projectTerminalSession) isClosed() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.closed
}

func (t *projectTerminalSession) snapshot() projectTerminalSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	state := "running"
	if t.closed {
		state = "exited"
	}
	return projectTerminalSnapshot{
		ID:        t.id,
		ProjectID: t.projectID,
		HostID:    t.hostID,
		Workdir:   t.workdir,
		Command:   t.command,
		State:     state,
		Cursor:    t.seq,
		StartedAt: t.startedAt,
		UpdatedAt: t.updatedAt,
		ExitCode:  t.exitCode,
		ClosedAt:  t.closedAt,
	}
}

func (t *projectTerminalSession) replay(after int64) []projectTerminalFrame {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.frames) == 0 {
		return nil
	}
	out := make([]projectTerminalFrame, 0, len(t.frames))
	for _, frame := range t.frames {
		if frame.Seq <= after {
			continue
		}
		out = append(out, frame)
	}
	return out
}

func (t *projectTerminalSession) subscribe(buffer int) (<-chan projectTerminalFrame, func()) {
	if buffer <= 0 {
		buffer = projectTerminalSubBuffer
	}
	ch := make(chan projectTerminalFrame, buffer)
	t.mu.Lock()
	id := t.nextSubID + 1
	t.nextSubID = id
	t.subs[id] = ch
	t.mu.Unlock()
	return ch, func() {
		t.mu.Lock()
		sub, ok := t.subs[id]
		if ok {
			delete(t.subs, id)
			close(sub)
		}
		t.mu.Unlock()
	}
}

func (t *projectTerminalSession) appendFrame(frame projectTerminalFrame) projectTerminalFrame {
	t.mu.Lock()
	frame.Seq = t.seq + 1
	t.seq = frame.Seq
	frame.Timestamp = frame.Timestamp.UTC()
	t.updatedAt = frame.Timestamp
	t.frames = append(t.frames, frame)
	if len(t.frames) > projectTerminalFrameBacklog {
		t.frames = append([]projectTerminalFrame(nil), t.frames[len(t.frames)-projectTerminalFrameBacklog:]...)
	}
	subs := make(map[int64]chan projectTerminalFrame, len(t.subs))
	for id, ch := range t.subs {
		subs[id] = ch
	}
	t.mu.Unlock()

	for id, ch := range subs {
		select {
		case ch <- frame:
		default:
			t.mu.Lock()
			if current, ok := t.subs[id]; ok && current == ch {
				delete(t.subs, id)
				close(current)
			}
			t.mu.Unlock()
		}
	}
	return frame
}

func (t *projectTerminalSession) writeInput(data string) error {
	trimmed := data
	if trimmed == "" {
		return nil
	}
	t.mu.Lock()
	proc := t.proc
	closed := t.closed
	t.mu.Unlock()
	if closed || proc == nil || proc.StdinPipe() == nil {
		return errors.New("project terminal is not running")
	}
	_, err := io.WriteString(proc.StdinPipe(), data)
	return err
}

func (t *projectTerminalSession) close() error {
	t.mu.Lock()
	proc := t.proc
	closed := t.closed
	t.mu.Unlock()
	if closed || proc == nil {
		return nil
	}
	return proc.Close()
}

func (t *projectTerminalSession) resize(rows int, cols int) error {
	t.mu.Lock()
	proc := t.proc
	closed := t.closed
	t.mu.Unlock()
	if closed || proc == nil {
		return errors.New("project terminal is not running")
	}
	return proc.Resize(rows, cols)
}

func (s *Server) handleProjectTerminalWS(w http.ResponseWriter, r *http.Request) {
	projectID := strings.TrimSpace(r.PathValue("id"))
	if projectID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing project id"})
		return
	}
	project, host, err := s.resolveProjectTerminalTarget(projectID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
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

	session, err := s.ensureProjectTerminal(project, host)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
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

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var msg map[string]any
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			switch strings.TrimSpace(asString(msg["type"])) {
			case "stdin":
				_ = session.writeInput(asString(msg["data"]))
			case "interrupt":
				_ = session.writeInput(string([]byte{3}))
			case "resize":
				rows, _ := asInt(msg["rows"])
				cols, _ := asInt(msg["cols"])
				_ = session.resize(rows, cols)
			case "close":
				_ = session.close()
			}
		}
	}()

	lastSeq := after
	for _, frame := range session.replay(after) {
		if err := writeWSFrame(conn, map[string]any{
			"type":  "terminal.frame",
			"id":    strconv.FormatInt(frame.Seq, 10),
			"frame": frame,
		}); err != nil {
			return
		}
		lastSeq = frame.Seq
	}
	if snapshot := session.snapshot(); snapshot.Cursor > lastSeq {
		lastSeq = snapshot.Cursor
	}
	if err := writeWSFrame(conn, map[string]any{
		"type":     "terminal.ready",
		"terminal": session.snapshot(),
		"cursor":   lastSeq,
	}); err != nil {
		return
	}

	streamCh, unsubscribe := session.subscribe(projectTerminalSubBuffer)
	defer unsubscribe()

	pingTicker := time.NewTicker(25 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-readDone:
			return
		case <-pingTicker.C:
			if err := conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(5*time.Second)); err != nil {
				return
			}
		case frame, ok := <-streamCh:
			if !ok {
				return
			}
			if frame.Seq <= lastSeq {
				continue
			}
			if err := writeWSFrame(conn, map[string]any{
				"type":  "terminal.frame",
				"id":    strconv.FormatInt(frame.Seq, 10),
				"frame": frame,
			}); err != nil {
				return
			}
			lastSeq = frame.Seq
		}
	}
}

func asInt(v any) (int, bool) {
	switch value := v.(type) {
	case float64:
		return int(value), true
	case int:
		return value, true
	case int64:
		return int(value), true
	default:
		return 0, false
	}
}

func (s *Server) resolveProjectTerminalTarget(projectID string) (model.ProjectRecord, model.Host, error) {
	project, ok := s.store.GetProject(projectID)
	if !ok {
		return model.ProjectRecord{}, model.Host{}, errors.New("project not found")
	}
	host, ok := s.store.GetHost(strings.TrimSpace(project.HostID))
	if !ok {
		return model.ProjectRecord{}, model.Host{}, errors.New("project host not found")
	}
	return project, host, nil
}

func (s *Server) ensureProjectTerminal(project model.ProjectRecord, host model.Host) (*projectTerminalSession, error) {
	projectID := strings.TrimSpace(project.ID)
	s.mu.Lock()
	existing := s.projectTerms[projectID]
	if existing != nil && !existing.isClosed() {
		s.mu.Unlock()
		return existing, nil
	}
	s.mu.Unlock()

	proc, err := executor.StartProjectTerminal(context.Background(), host, strings.TrimSpace(project.Path))
	if err != nil {
		return nil, err
	}
	created := newProjectTerminalSession(project, host, proc)

	s.mu.Lock()
	if current := s.projectTerms[projectID]; current != nil && !current.isClosed() {
		s.mu.Unlock()
		_ = created.close()
		return current, nil
	}
	s.projectTerms[projectID] = created
	s.mu.Unlock()

	s.startProjectTerminalReaders(projectID, created)
	return created, nil
}

func (s *Server) startProjectTerminalReaders(projectID string, session *projectTerminalSession) {
	if session == nil || session.proc == nil {
		return
	}
	if stdout := session.proc.StdoutPipe(); stdout != nil {
		go s.pipeProjectTerminalOutput(projectID, session, "stdout", stdout)
	}
	if stderr := session.proc.StderrPipe(); stderr != nil {
		go s.pipeProjectTerminalOutput(projectID, session, "stderr", stderr)
	}
	go s.waitProjectTerminal(projectID, session)
}

func (s *Server) pipeProjectTerminalOutput(projectID string, session *projectTerminalSession, stream string, reader io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			session.appendFrame(projectTerminalFrame{
				Type:      "output",
				Stream:    stream,
				Data:      string(buf[:n]),
				Timestamp: time.Now().UTC(),
			})
		}
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, os.ErrClosed) {
				return
			}
			return
		}
	}
}

func (s *Server) waitProjectTerminal(projectID string, session *projectTerminalSession) {
	err := session.proc.Wait()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	now := time.Now().UTC()
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.closed = true
	session.closedAt = &now
	session.exitCode = &exitCode
	session.mu.Unlock()
	session.appendFrame(projectTerminalFrame{
		Type:      "exit",
		ExitCode:  exitCode,
		Timestamp: now,
	})
}
