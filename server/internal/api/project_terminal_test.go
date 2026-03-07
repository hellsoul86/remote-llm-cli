package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

func installFakeReviewStartCodexBinary(t *testing.T, capturePath string) {
	t.Helper()

	binDir := t.TempDir()
	binPath := filepath.Join(binDir, "codex")
	script := fmt.Sprintf(`#!/usr/bin/env python3
import json
import sys

capture_path = %q

def respond(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    method = str(msg.get("method", "")).strip()
    msg_id = msg.get("id")
    if method == "initialize":
        if msg_id is not None:
            respond({"id": msg_id, "result": {"server": "fake"}})
        continue
    if method == "initialized":
        continue
    if method == "review/start":
        with open(capture_path, "w", encoding="utf-8") as fh:
            json.dump(msg.get("params", {}), fh)
        if msg_id is not None:
            respond({
                "id": msg_id,
                "result": {
                    "reviewThreadId": "session_review_1",
                    "turn": {"id": "turn_review_1"},
                },
            })
        continue
    if msg_id is not None:
        respond({"id": msg_id, "result": {}})
`, capturePath)
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake codex binary: %v", err)
	}

	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func readJSONFileEventually(t *testing.T, path string, timeout time.Duration) map[string]any {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(path)
		if err == nil && len(raw) > 0 {
			var out map[string]any
			if err := json.Unmarshal(raw, &out); err != nil {
				t.Fatalf("decode captured json: %v", err)
			}
			return out
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
	return nil
}

func TestCodexV2ReviewStartUsesStructuredBaseBranchTarget(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()
	defer srv.codexBridge.Close()

	workdir := t.TempDir()
	capturePath := filepath.Join(t.TempDir(), "review-start.json")
	installFakeReviewStartCodexBinary(t, capturePath)

	host.ConnectionMode = "local"
	host.Workspace = workdir
	host.Host = "localhost"
	host.User = ""
	updatedHost, err := srv.store.UpsertHost(host)
	if err != nil {
		t.Fatalf("upsert local host: %v", err)
	}

	project, err := srv.store.UpsertProject(model.ProjectRecord{
		ID:       "project_review_1",
		HostID:   updatedHost.ID,
		HostName: updatedHost.Name,
		Path:     workdir,
		Title:    "review",
		Runtime:  "codex",
	})
	if err != nil {
		t.Fatalf("upsert project: %v", err)
	}
	if _, err := srv.store.UpsertSession(model.SessionRecord{
		ID:        "session_review_1",
		ProjectID: project.ID,
		HostID:    updatedHost.ID,
		Path:      project.Path,
		Runtime:   "codex",
		Title:     "Review session",
	}); err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	var resp codexV2ReviewStartResult
	status := doJSON(
		t,
		httpSrv.Client(),
		"POST",
		fmt.Sprintf("%s/v2/codex/sessions/%s/review/start", httpSrv.URL, "session_review_1"),
		token,
		map[string]any{"review_base": "main"},
		&resp,
	)
	if status != 200 {
		t.Fatalf("status=%d want=200", status)
	}
	if resp.ReviewThreadID != "session_review_1" {
		t.Fatalf("review_thread_id=%q want=session_review_1", resp.ReviewThreadID)
	}
	if resp.Session.LastRunID != "turn_review_1" {
		t.Fatalf("session last_run_id=%q want=turn_review_1", resp.Session.LastRunID)
	}

	params := readJSONFileEventually(t, capturePath, 2*time.Second)
	if got := asString(params["threadId"]); got != "session_review_1" {
		t.Fatalf("threadId=%q want=session_review_1", got)
	}
	if got := asString(params["delivery"]); got != "inline" {
		t.Fatalf("delivery=%q want=inline", got)
	}
	target, ok := params["target"].(map[string]any)
	if !ok {
		t.Fatalf("target missing: %#v", params)
	}
	if got := asString(target["type"]); got != "baseBranch" {
		t.Fatalf("target type=%q want=baseBranch", got)
	}
	if got := asString(target["branch"]); got != "main" {
		t.Fatalf("target branch=%q want=main", got)
	}
}

func TestProjectTerminalWSStreamsLocalShellOutput(t *testing.T) {
	srv, httpSrv, token, host := newAuthedTestServer(t)
	defer httpSrv.Close()

	workdir := t.TempDir()
	host.ConnectionMode = "local"
	host.Workspace = workdir
	host.Host = "localhost"
	host.User = ""
	updatedHost, err := srv.store.UpsertHost(host)
	if err != nil {
		t.Fatalf("upsert local host: %v", err)
	}
	project, err := srv.store.UpsertProject(model.ProjectRecord{
		ID:       "project_terminal_1",
		HostID:   updatedHost.ID,
		HostName: updatedHost.Name,
		Path:     workdir,
		Title:    "terminal",
		Runtime:  "codex",
	})
	if err != nil {
		t.Fatalf("upsert project: %v", err)
	}

	base, err := url.Parse(httpSrv.URL)
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
		Path:   fmt.Sprintf("/v2/projects/%s/terminal/ws", project.ID),
	}
	query := wsURL.Query()
	query.Set("access_token", token)
	wsURL.RawQuery = query.Encode()

	conn, res, err := websocket.DefaultDialer.Dial(wsURL.String(), nil)
	if err != nil {
		body := ""
		if res != nil {
			raw, _ := io.ReadAll(res.Body)
			_ = res.Body.Close()
			body = string(raw)
		}
		t.Fatalf("dial terminal ws: %v body=%q", err, body)
	}
	defer conn.Close()

	ready := readWSFrameType(t, conn, "terminal.ready", 5*time.Second)
	terminalObj, ok := ready["terminal"].(map[string]any)
	if !ok {
		t.Fatalf("terminal snapshot missing: %#v", ready)
	}
	if got := asString(terminalObj["project_id"]); got != project.ID {
		t.Fatalf("project_id=%q want=%q", got, project.ID)
	}

	if err := conn.WriteJSON(map[string]any{
		"type": "stdin",
		"data": "printf '__TERM_OK__\\n'\n",
	}); err != nil {
		t.Fatalf("write stdin frame: %v", err)
	}

	deadline := time.Now().Add(12 * time.Second)
	found := false
	for time.Now().Before(deadline) {
		frame := readWSFrame(t, conn, 1500*time.Millisecond)
		if strings.TrimSpace(asString(frame["type"])) != "terminal.frame" {
			continue
		}
		payload, ok := frame["frame"].(map[string]any)
		if !ok {
			continue
		}
		if strings.Contains(asString(payload["data"]), "__TERM_OK__") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected terminal output marker")
	}

	if err := conn.WriteJSON(map[string]any{"type": "close"}); err != nil {
		t.Fatalf("write close frame: %v", err)
	}
	frame := readWSFrameType(t, conn, "terminal.frame", 5*time.Second)
	payload, ok := frame["frame"].(map[string]any)
	if !ok {
		t.Fatalf("terminal frame missing: %#v", frame)
	}
	if got := asString(payload["type"]); got != "exit" {
		t.Fatalf("terminal frame type=%q want=exit", got)
	}
}
