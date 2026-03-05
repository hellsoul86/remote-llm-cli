package codexrpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
)

type fakeProcess struct {
	command string

	stdinR *io.PipeReader
	stdinW *io.PipeWriter

	stdoutR *io.PipeReader
	stdoutW *io.PipeWriter

	stderrR *io.PipeReader
	stderrW *io.PipeWriter

	mu      sync.Mutex
	waitErr error
	done    chan struct{}
	once    sync.Once
}

func newFakeProcess(command string) *fakeProcess {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	stderrR, stderrW := io.Pipe()
	return &fakeProcess{
		command: command,
		stdinR:  stdinR,
		stdinW:  stdinW,
		stdoutR: stdoutR,
		stdoutW: stdoutW,
		stderrR: stderrR,
		stderrW: stderrW,
		done:    make(chan struct{}),
	}
}

func (f *fakeProcess) CommandLine() string       { return f.command }
func (f *fakeProcess) StdinPipe() io.WriteCloser { return f.stdinW }
func (f *fakeProcess) StdoutPipe() io.ReadCloser { return f.stdoutR }
func (f *fakeProcess) StderrPipe() io.ReadCloser { return f.stderrR }
func (f *fakeProcess) Wait() error               { <-f.done; f.mu.Lock(); defer f.mu.Unlock(); return f.waitErr }
func (f *fakeProcess) Close() error              { f.exit(nil); return nil }
func (f *fakeProcess) ReadClientLine() (string, error) {
	reader := bufio.NewReader(f.stdinR)
	line, err := reader.ReadString('\n')
	return strings.TrimSpace(line), err
}

func (f *fakeProcess) WriteServerMessage(payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := f.stdoutW.Write(raw); err != nil {
		return err
	}
	_, err = f.stdoutW.Write([]byte("\n"))
	return err
}

func (f *fakeProcess) exit(err error) {
	f.once.Do(func() {
		f.mu.Lock()
		f.waitErr = err
		f.mu.Unlock()
		_ = f.stdinW.Close()
		_ = f.stdinR.Close()
		_ = f.stdoutW.Close()
		_ = f.stdoutR.Close()
		_ = f.stderrW.Close()
		_ = f.stderrR.Close()
		close(f.done)
	})
}

func serveFakeAppServer(t *testing.T, proc *fakeProcess, tag string, closeAfterFirstCall bool) {
	t.Helper()
	go func() {
		scanner := bufio.NewScanner(proc.stdinR)
		scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		handledCalls := 0
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var msg map[string]any
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				continue
			}
			method := strings.TrimSpace(asString(msg["method"]))
			id, hasID := msg["id"]
			switch method {
			case "initialize":
				if hasID {
					_ = proc.WriteServerMessage(map[string]any{
						"id":     id,
						"result": map[string]any{"server": "fake"},
					})
				}
			case "initialized":
				// no-op
			default:
				if hasID {
					handledCalls += 1
					_ = proc.WriteServerMessage(map[string]any{
						"method": "thread/started",
						"params": map[string]any{"thread": map[string]any{"id": "thr_" + tag}},
					})
					_ = proc.WriteServerMessage(map[string]any{
						"id": id,
						"result": map[string]any{
							"tag":    tag,
							"method": method,
						},
					})
					if closeAfterFirstCall && handledCalls == 1 {
						proc.exit(errors.New("process crashed"))
						return
					}
				}
			}
		}
		proc.exit(scanner.Err())
	}()
}

func asString(v any) string {
	switch val := v.(type) {
	case string:
		return val
	default:
		return ""
	}
}

func TestBridgeCallAndNotifications(t *testing.T) {
	proc := newFakeProcess("fake-1")
	serveFakeAppServer(t, proc, "one", false)

	started := int32(0)
	bridge := NewBridgeWithStarter(
		model.Host{ID: "h_test", ConnectionMode: "local"},
		BridgeOptions{
			StartupTimeout: 2 * time.Second,
			RequestTimeout: 2 * time.Second,
			ClientInfo: ClientInfo{
				Name:    "test",
				Title:   "test",
				Version: "1",
			},
		},
		func(ctx context.Context, host model.Host, spec runtime.CommandSpec, workdir string) (bridgeProcess, error) {
			atomic.AddInt32(&started, 1)
			return proc, nil
		},
	)
	defer bridge.Close()

	notifications, stop := bridge.SubscribeNotifications(8)
	defer stop()

	var out struct {
		Tag    string `json:"tag"`
		Method string `json:"method"`
	}
	if err := bridge.Call(context.Background(), "thread/start", map[string]any{
		"input": []map[string]any{{"type": "text", "text": "hello"}},
	}, &out); err != nil {
		t.Fatalf("call failed: %v", err)
	}
	if out.Tag != "one" {
		t.Fatalf("unexpected call response tag: %q", out.Tag)
	}
	if out.Method != "thread/start" {
		t.Fatalf("unexpected call response method: %q", out.Method)
	}
	if got := atomic.LoadInt32(&started); got != 1 {
		t.Fatalf("expected bridge to start once, got %d", got)
	}

	select {
	case event := <-notifications:
		if event.Method != "thread/started" {
			t.Fatalf("unexpected notification method: %q", event.Method)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected notification")
	}
}

func TestBridgeReconnectAfterProcessExit(t *testing.T) {
	first := newFakeProcess("fake-first")
	second := newFakeProcess("fake-second")
	serveFakeAppServer(t, first, "first", true)
	serveFakeAppServer(t, second, "second", false)

	var starts int32
	startFn := func(ctx context.Context, host model.Host, spec runtime.CommandSpec, workdir string) (bridgeProcess, error) {
		next := atomic.AddInt32(&starts, 1)
		if next == 1 {
			return first, nil
		}
		return second, nil
	}

	bridge := NewBridgeWithStarter(
		model.Host{ID: "h_test", ConnectionMode: "local"},
		BridgeOptions{
			StartupTimeout:      2 * time.Second,
			RequestTimeout:      2 * time.Second,
			ReconnectMinBackoff: 20 * time.Millisecond,
			ReconnectMaxBackoff: 120 * time.Millisecond,
			ClientInfo: ClientInfo{
				Name:    "test",
				Title:   "test",
				Version: "1",
			},
		},
		startFn,
	)
	defer bridge.Close()

	var firstResp struct {
		Tag string `json:"tag"`
	}
	if err := bridge.Call(context.Background(), "model/list", map[string]any{}, &firstResp); err != nil {
		t.Fatalf("first call failed: %v", err)
	}
	if firstResp.Tag != "first" {
		t.Fatalf("unexpected first response tag: %q", firstResp.Tag)
	}

	deadline := time.Now().Add(3 * time.Second)

	var secondResp struct {
		Tag string `json:"tag"`
	}
	for {
		err := bridge.Call(context.Background(), "model/list", map[string]any{}, &secondResp)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("second call did not recover: %v", err)
		}
		time.Sleep(30 * time.Millisecond)
	}
	if secondResp.Tag != "second" {
		t.Fatalf("unexpected second response tag: %q", secondResp.Tag)
	}
	if got := atomic.LoadInt32(&starts); got < 2 {
		t.Fatalf("expected reconnect to start a second process, starts=%d", got)
	}
}
