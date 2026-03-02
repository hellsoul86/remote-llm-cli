package tuiapp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type APIClient struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func NewAPIClient(baseURL string, token string) *APIClient {
	return &APIClient{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   strings.TrimSpace(token),
		HTTP: &http.Client{
			Timeout: 5 * time.Minute,
		},
	}
}

type Host struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Host         string `json:"host"`
	User         string `json:"user"`
	Port         int    `json:"port"`
	IdentityFile string `json:"identity_file,omitempty"`
	Workspace    string `json:"workspace,omitempty"`
}

type ListHostsResponse struct {
	Hosts []Host `json:"hosts"`
}

type RunRequest struct {
	Runtime        string           `json:"runtime"`
	Prompt         string           `json:"prompt"`
	HostIDs        []string         `json:"host_ids,omitempty"`
	AllHosts       bool             `json:"all_hosts,omitempty"`
	Fanout         int              `json:"fanout,omitempty"`
	Workdir        string           `json:"workdir,omitempty"`
	MaxOutputKB    int              `json:"max_output_kb,omitempty"`
	RetryCount     int              `json:"retry_count,omitempty"`
	RetryBackoffMS int              `json:"retry_backoff_ms,omitempty"`
	Codex          *CodexRunOptions `json:"codex,omitempty"`
}

type CodexRunOptions struct {
	Mode             string `json:"mode,omitempty"`
	SessionID        string `json:"session_id,omitempty"`
	ResumeLast       bool   `json:"resume_last,omitempty"`
	Model            string `json:"model,omitempty"`
	Sandbox          string `json:"sandbox,omitempty"`
	SkipGitRepoCheck bool   `json:"skip_git_repo_check,omitempty"`
	Ephemeral        bool   `json:"ephemeral,omitempty"`
	JSONOutput       bool   `json:"json_output,omitempty"`
}

type RunTarget struct {
	Host struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"host"`
	Result struct {
		ExitCode        int   `json:"exit_code"`
		DurationMS      int64 `json:"duration_ms"`
		StdoutBytes     int   `json:"stdout_bytes"`
		StderrBytes     int   `json:"stderr_bytes"`
		StdoutTruncated bool  `json:"stdout_truncated"`
		StderrTruncated bool  `json:"stderr_truncated"`
	} `json:"result"`
	OK       bool   `json:"ok"`
	Error    string `json:"error"`
	Attempts int    `json:"attempts"`
	Codex    *struct {
		JSONL         bool   `json:"jsonl"`
		EventCount    int    `json:"event_count"`
		InvalidLines  int    `json:"invalid_lines"`
		LastEventType string `json:"last_event_type"`
		ParseError    string `json:"parse_error"`
	} `json:"codex,omitempty"`
}

type RunResponse struct {
	Runtime string `json:"runtime"`
	Summary struct {
		Total          int   `json:"total"`
		Succeeded      int   `json:"succeeded"`
		Failed         int   `json:"failed"`
		Fanout         int   `json:"fanout"`
		RetryCount     int   `json:"retry_count"`
		RetryBackoffMS int64 `json:"retry_backoff_ms"`
		DurationMS     int64 `json:"duration_ms"`
	} `json:"summary"`
	Targets []RunTarget `json:"targets"`
}

type RunRecord struct {
	ID             string `json:"id"`
	Runtime        string `json:"runtime"`
	PromptPreview  string `json:"prompt_preview"`
	TotalHosts     int    `json:"total_hosts"`
	SucceededHosts int    `json:"succeeded_hosts"`
	FailedHosts    int    `json:"failed_hosts"`
	Fanout         int    `json:"fanout"`
	StatusCode     int    `json:"status_code"`
	DurationMS     int64  `json:"duration_ms"`
	StartedAt      string `json:"started_at"`
	FinishedAt     string `json:"finished_at"`
}

type AuditEvent struct {
	ID         string `json:"id"`
	Timestamp  string `json:"timestamp"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	StatusCode int    `json:"status_code"`
	DurationMS int64  `json:"duration_ms"`
	Action     string `json:"action"`
}

type listRunsResponse struct {
	Runs []RunRecord `json:"runs"`
}

type listAuditResponse struct {
	Events []AuditEvent `json:"events"`
}

func (c *APIClient) ListHosts() ([]Host, error) {
	url := c.BaseURL + "/v1/hosts"
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	c.applyAuth(req)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("list hosts failed: http %d", res.StatusCode)
	}
	var out ListHostsResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Hosts == nil {
		return []Host{}, nil
	}
	return out.Hosts, nil
}

func (c *APIClient) Run(reqBody RunRequest) (int, RunResponse, error) {
	url := c.BaseURL + "/v1/run"
	raw, err := json.Marshal(reqBody)
	if err != nil {
		return 0, RunResponse{}, err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return 0, RunResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	c.applyAuth(req)

	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, RunResponse{}, err
	}
	defer res.Body.Close()

	var out RunResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return res.StatusCode, RunResponse{}, err
	}
	if out.Targets == nil {
		out.Targets = []RunTarget{}
	}
	return res.StatusCode, out, nil
}

func (c *APIClient) ListRuns(limit int) ([]RunRecord, error) {
	url := fmt.Sprintf("%s/v1/runs?limit=%d", c.BaseURL, limit)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	c.applyAuth(req)

	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("list runs failed: http %d", res.StatusCode)
	}

	var out listRunsResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Runs == nil {
		return []RunRecord{}, nil
	}
	return out.Runs, nil
}

func (c *APIClient) ListAudit(limit int) ([]AuditEvent, error) {
	url := fmt.Sprintf("%s/v1/audit?limit=%d", c.BaseURL, limit)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	c.applyAuth(req)

	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("list audit failed: http %d", res.StatusCode)
	}

	var out listAuditResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Events == nil {
		return []AuditEvent{}, nil
	}
	return out.Events, nil
}

func (c *APIClient) applyAuth(req *http.Request) {
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
}
