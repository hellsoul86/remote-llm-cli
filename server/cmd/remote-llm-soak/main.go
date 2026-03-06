package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type config struct {
	APIBase         string
	Token           string
	HostID          string
	Path            string
	Title           string
	Model           string
	Duration        time.Duration
	ReconnectWindow time.Duration
	PromptInterval  time.Duration
	Prompt          string
	ArchiveOnExit   bool
	OutputPath      string
}

type soakReport struct {
	APIBase         string            `json:"api_base"`
	HostID          string            `json:"host_id"`
	Path            string            `json:"path"`
	SessionID       string            `json:"session_id"`
	StartedAt       time.Time         `json:"started_at"`
	EndedAt         time.Time         `json:"ended_at"`
	DurationSec     int64             `json:"duration_sec"`
	ReconnectWindow string            `json:"reconnect_window"`
	PromptInterval  string            `json:"prompt_interval"`
	PromptTemplate  string            `json:"prompt_template"`
	Stream          streamStats       `json:"stream"`
	Turns           turnStats         `json:"turns"`
	EventTypeCounts map[string]int    `json:"event_type_counts"`
	RunTerminal     map[string]int    `json:"run_terminal_counts"`
	Errors          []string          `json:"errors,omitempty"`
	Extra           map[string]string `json:"extra,omitempty"`
}

type streamStats struct {
	ConnectAttempts int   `json:"connect_attempts"`
	ConnectFailures int   `json:"connect_failures"`
	ReadyFrames     int   `json:"ready_frames"`
	ResetFrames     int   `json:"reset_frames"`
	HeartbeatFrames int   `json:"heartbeat_frames"`
	SessionEvents   int   `json:"session_events"`
	LastSeq         int64 `json:"last_seq"`
	DuplicateSeq    int   `json:"duplicate_seq"`
	NonMonotonicSeq int   `json:"non_monotonic_seq"`
	MissingSeq      int   `json:"missing_seq"`
}

type turnStats struct {
	Attempted int `json:"attempted"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
}

type soakClient struct {
	cfg        config
	httpClient *http.Client
	report     soakReport
}

type sseFrame struct {
	id    string
	event string
	data  strings.Builder
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "remote-llm-soak: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := parseFlags()
	if err != nil {
		return err
	}
	if err := validateConfig(cfg); err != nil {
		return err
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := &soakClient{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 0,
		},
		report: soakReport{
			APIBase:         cfg.APIBase,
			HostID:          cfg.HostID,
			Path:            cfg.Path,
			StartedAt:       time.Now().UTC(),
			ReconnectWindow: cfg.ReconnectWindow.String(),
			PromptInterval:  cfg.PromptInterval.String(),
			PromptTemplate:  cfg.Prompt,
			EventTypeCounts: map[string]int{},
			RunTerminal:     map[string]int{},
			Extra:           map[string]string{},
		},
	}

	sessionID, err := client.startSession(rootCtx)
	if err != nil {
		return err
	}
	client.report.SessionID = sessionID

	if err := client.startTurn(rootCtx, cfg.Prompt); err != nil {
		client.addError(fmt.Sprintf("initial turn failed: %v", err))
	}

	deadline := time.Now().Add(cfg.Duration)
	nextPromptAt := time.Now().Add(cfg.PromptInterval)

	for {
		now := time.Now()
		if !deadline.After(now) {
			break
		}
		if cfg.PromptInterval > 0 && !nextPromptAt.After(now) {
			if err := client.startTurn(rootCtx, cfg.Prompt); err != nil {
				client.addError(fmt.Sprintf("periodic turn failed: %v", err))
			}
			nextPromptAt = now.Add(cfg.PromptInterval)
		}

		window := cfg.ReconnectWindow
		if remain := time.Until(deadline); remain < window {
			window = remain
		}
		if window <= 0 {
			break
		}

		if err := client.consumeStreamWindow(rootCtx, window); err != nil {
			client.addError(fmt.Sprintf("stream window error: %v", err))
		}
	}

	if cfg.ArchiveOnExit {
		if err := client.archiveSession(rootCtx); err != nil {
			client.addError(fmt.Sprintf("archive session failed: %v", err))
		} else {
			client.report.Extra["archived"] = "true"
		}
	}

	client.report.EndedAt = time.Now().UTC()
	client.report.DurationSec = int64(client.report.EndedAt.Sub(client.report.StartedAt).Seconds())

	return writeReport(client.report, cfg.OutputPath)
}

func parseFlags() (config, error) {
	cfg := config{}
	flag.StringVar(&cfg.APIBase, "api", envOrDefault("REMOTE_LLM_API", "http://127.0.0.1:8080"), "remote-llm-server API base URL")
	flag.StringVar(&cfg.Token, "token", envOrDefault("REMOTE_LLM_KEY", ""), "access token (or REMOTE_LLM_KEY)")
	flag.StringVar(&cfg.HostID, "host-id", envOrDefault("REMOTE_LLM_HOST_ID", ""), "target host id")
	flag.StringVar(&cfg.Path, "path", envOrDefault("REMOTE_LLM_PROJECT_PATH", ""), "project path for session start")
	flag.StringVar(&cfg.Title, "title", envOrDefault("REMOTE_LLM_SOAK_TITLE", "staging-soak"), "session title")
	flag.StringVar(&cfg.Model, "model", envOrDefault("REMOTE_LLM_MODEL", ""), "optional model")
	flag.DurationVar(&cfg.Duration, "duration", 30*time.Minute, "soak duration")
	flag.DurationVar(&cfg.ReconnectWindow, "reconnect-window", 30*time.Second, "intentional stream reconnect window")
	flag.DurationVar(&cfg.PromptInterval, "prompt-interval", 2*time.Minute, "interval to start another turn")
	flag.StringVar(&cfg.Prompt, "prompt", "Reply with one short line: soak heartbeat acknowledged.", "prompt for each synthetic turn")
	flag.BoolVar(&cfg.ArchiveOnExit, "archive-on-exit", false, "archive the created session when soak ends")
	flag.StringVar(&cfg.OutputPath, "out", "", "output JSON report path (default stdout)")
	flag.Parse()
	return cfg, nil
}

func validateConfig(cfg config) error {
	if strings.TrimSpace(cfg.APIBase) == "" {
		return errors.New("api is required")
	}
	if strings.TrimSpace(cfg.Token) == "" {
		return errors.New("token is required")
	}
	if strings.TrimSpace(cfg.HostID) == "" {
		return errors.New("host-id is required")
	}
	if cfg.Duration < 10*time.Second {
		return errors.New("duration must be >= 10s")
	}
	if cfg.ReconnectWindow < 2*time.Second {
		return errors.New("reconnect-window must be >= 2s")
	}
	return nil
}

func (c *soakClient) startSession(ctx context.Context) (string, error) {
	body := map[string]any{
		"host_id": c.cfg.HostID,
		"title":   c.cfg.Title,
	}
	if path := strings.TrimSpace(c.cfg.Path); path != "" {
		body["path"] = path
	}
	if model := strings.TrimSpace(c.cfg.Model); model != "" {
		body["model"] = model
	}
	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + "/v2/codex/sessions/start"

	var resp struct {
		Session struct {
			ID string `json:"id"`
		} `json:"session"`
	}
	if err := c.doJSON(ctx, http.MethodPost, endpoint, body, &resp); err != nil {
		return "", fmt.Errorf("start session: %w", err)
	}
	id := strings.TrimSpace(resp.Session.ID)
	if id == "" {
		return "", errors.New("start session returned empty session.id")
	}
	return id, nil
}

func (c *soakClient) startTurn(ctx context.Context, prompt string) error {
	c.report.Turns.Attempted++

	body := map[string]any{
		"host_id": c.cfg.HostID,
		"prompt":  prompt,
	}
	if model := strings.TrimSpace(c.cfg.Model); model != "" {
		body["model"] = model
	}
	endpoint := fmt.Sprintf(
		"%s/v2/codex/sessions/%s/turns/start",
		strings.TrimRight(c.cfg.APIBase, "/"),
		url.PathEscape(c.report.SessionID),
	)
	if err := c.doJSON(ctx, http.MethodPost, endpoint, body, nil); err != nil {
		c.report.Turns.Failed++
		return err
	}
	c.report.Turns.Succeeded++
	return nil
}

func (c *soakClient) archiveSession(ctx context.Context) error {
	body := map[string]any{
		"host_id": c.cfg.HostID,
	}
	endpoint := fmt.Sprintf(
		"%s/v2/codex/sessions/%s/archive",
		strings.TrimRight(c.cfg.APIBase, "/"),
		url.PathEscape(c.report.SessionID),
	)
	return c.doJSON(ctx, http.MethodPost, endpoint, body, nil)
}

func (c *soakClient) consumeStreamWindow(parent context.Context, window time.Duration) error {
	ctx, cancel := context.WithTimeout(parent, window)
	defer cancel()

	streamURL := fmt.Sprintf(
		"%s/v2/codex/sessions/%s/stream?after=%d",
		strings.TrimRight(c.cfg.APIBase, "/"),
		url.PathEscape(c.report.SessionID),
		c.report.Stream.LastSeq,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, streamURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	if c.report.Stream.LastSeq > 0 {
		req.Header.Set("Last-Event-ID", strconv.FormatInt(c.report.Stream.LastSeq, 10))
	}
	c.report.Stream.ConnectAttempts++

	res, err := c.httpClient.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(ctx.Err(), context.Canceled) {
			return nil
		}
		c.report.Stream.ConnectFailures++
		return err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		c.report.Stream.ConnectFailures++
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("stream status=%d body=%q", res.StatusCode, strings.TrimSpace(string(body)))
	}

	return c.consumeSSE(ctx, res.Body)
}

func (c *soakClient) consumeSSE(ctx context.Context, body io.Reader) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)

	frame := sseFrame{}
	flush := func() {
		if frame.event == "" && frame.id == "" && frame.data.Len() == 0 {
			return
		}
		c.applyFrame(frame)
		frame = sseFrame{}
	}

	for scanner.Scan() {
		select {
		case <-ctx.Done():
			flush()
			return nil
		default:
		}

		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		switch {
		case strings.HasPrefix(line, "id:"):
			frame.id = strings.TrimSpace(strings.TrimPrefix(line, "id:"))
		case strings.HasPrefix(line, "event:"):
			frame.event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			part := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if frame.data.Len() > 0 {
				frame.data.WriteByte('\n')
			}
			frame.data.WriteString(part)
		}
	}
	flush()

	err := scanner.Err()
	if err == nil {
		return nil
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(ctx.Err(), context.Canceled) {
		return nil
	}
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func (c *soakClient) applyFrame(frame sseFrame) {
	switch frame.event {
	case "session.ready":
		c.report.Stream.ReadyFrames++
		return
	case "session.reset":
		c.report.Stream.ResetFrames++
		return
	case "heartbeat":
		c.report.Stream.HeartbeatFrames++
		return
	case "session.event":
		c.report.Stream.SessionEvents++
	default:
		if strings.TrimSpace(frame.event) != "" {
			c.report.EventTypeCounts["sse."+strings.TrimSpace(frame.event)]++
		}
		return
	}

	seq, err := strconv.ParseInt(strings.TrimSpace(frame.id), 10, 64)
	if err != nil || seq <= 0 {
		c.addError(fmt.Sprintf("invalid session.event id=%q", frame.id))
		return
	}
	last := c.report.Stream.LastSeq
	switch {
	case seq == last:
		c.report.Stream.DuplicateSeq++
		return
	case seq < last:
		c.report.Stream.NonMonotonicSeq++
		return
	case seq > last+1:
		c.report.Stream.MissingSeq += int(seq - last - 1)
	}
	c.report.Stream.LastSeq = seq

	var eventPayload struct {
		Type string `json:"type"`
	}
	if data := strings.TrimSpace(frame.data.String()); data != "" {
		if err := json.Unmarshal([]byte(data), &eventPayload); err != nil {
			c.addError(fmt.Sprintf("decode session.event payload failed: %v", err))
		}
	}
	eventType := strings.TrimSpace(eventPayload.Type)
	if eventType != "" {
		c.report.EventTypeCounts[eventType]++
		switch eventType {
		case "run.completed":
			c.report.RunTerminal["completed"]++
		case "run.failed":
			c.report.RunTerminal["failed"]++
		case "run.canceled":
			c.report.RunTerminal["canceled"]++
		}
	}
}

func (c *soakClient) doJSON(ctx context.Context, method string, endpoint string, body any, out any) error {
	var payload []byte
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = raw
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	req.Header.Set("Content-Type", "application/json")

	res, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode >= http.StatusBadRequest {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("status=%d body=%q", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (c *soakClient) addError(msg string) {
	if strings.TrimSpace(msg) == "" {
		return
	}
	const maxErrors = 40
	if len(c.report.Errors) >= maxErrors {
		return
	}
	c.report.Errors = append(c.report.Errors, msg)
}

func writeReport(report soakReport, path string) error {
	raw, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if strings.TrimSpace(path) == "" {
		fmt.Println(string(raw))
		return nil
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote soak report: %s\n", path)
	return nil
}

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
