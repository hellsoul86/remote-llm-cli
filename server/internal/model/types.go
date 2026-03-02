package model

import (
	"encoding/json"
	"time"
)

type Host struct {
	ID                        string    `json:"id"`
	Name                      string    `json:"name"`
	Host                      string    `json:"host"`
	User                      string    `json:"user"`
	Port                      int       `json:"port"`
	IdentityFile              string    `json:"identity_file,omitempty"`
	Workspace                 string    `json:"workspace,omitempty"`
	Tags                      []string  `json:"tags,omitempty"`
	SSHProxyJump              string    `json:"ssh_proxy_jump,omitempty"`
	SSHConnectTimeoutSec      int       `json:"ssh_connect_timeout_sec,omitempty"`
	SSHServerAliveIntervalSec int       `json:"ssh_server_alive_interval_sec,omitempty"`
	SSHServerAliveCountMax    int       `json:"ssh_server_alive_count_max,omitempty"`
	SSHHostKeyPolicy          string    `json:"ssh_host_key_policy,omitempty"`
	CreatedAt                 time.Time `json:"created_at"`
	UpdatedAt                 time.Time `json:"updated_at"`
}

type AccessKey struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	Hash       string     `json:"hash"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

type RuntimeCapabilities struct {
	SupportsNonInteractiveExec bool `json:"supports_non_interactive_exec"`
	SupportsInteractiveSession bool `json:"supports_interactive_session"`
	SupportsStructuredOutput   bool `json:"supports_structured_output"`
	SupportsFilePatchMode      bool `json:"supports_file_patch_mode"`
	SupportsCostMetrics        bool `json:"supports_cost_metrics"`
}

type RuntimeInfo struct {
	Name         string              `json:"name"`
	Capabilities RuntimeCapabilities `json:"capabilities"`
}

type RunTargetSummary struct {
	HostID     string `json:"host_id"`
	HostName   string `json:"host_name"`
	OK         bool   `json:"ok"`
	ExitCode   int    `json:"exit_code"`
	DurationMS int64  `json:"duration_ms"`
	Error      string `json:"error,omitempty"`
	ErrorClass string `json:"error_class,omitempty"`
}

type RunRecord struct {
	ID             string             `json:"id"`
	Runtime        string             `json:"runtime"`
	PromptPreview  string             `json:"prompt_preview"`
	TotalHosts     int                `json:"total_hosts"`
	SucceededHosts int                `json:"succeeded_hosts"`
	FailedHosts    int                `json:"failed_hosts"`
	Fanout         int                `json:"fanout"`
	StatusCode     int                `json:"status_code"`
	DurationMS     int64              `json:"duration_ms"`
	CreatedByKeyID string             `json:"created_by_key_id,omitempty"`
	StartedAt      time.Time          `json:"started_at"`
	FinishedAt     time.Time          `json:"finished_at"`
	Targets        []RunTargetSummary `json:"targets"`
}

type RunJobRecord struct {
	ID             string          `json:"id"`
	Type           string          `json:"type"`
	Status         string          `json:"status"`
	Runtime        string          `json:"runtime"`
	PromptPreview  string          `json:"prompt_preview"`
	CreatedByKeyID string          `json:"created_by_key_id,omitempty"`
	QueuedAt       time.Time       `json:"queued_at"`
	StartedAt      *time.Time      `json:"started_at,omitempty"`
	FinishedAt     *time.Time      `json:"finished_at,omitempty"`
	ResultStatus   int             `json:"result_status,omitempty"`
	TotalHosts     int             `json:"total_hosts,omitempty"`
	SucceededHosts int             `json:"succeeded_hosts,omitempty"`
	FailedHosts    int             `json:"failed_hosts,omitempty"`
	Fanout         int             `json:"fanout,omitempty"`
	DurationMS     int64           `json:"duration_ms,omitempty"`
	Error          string          `json:"error,omitempty"`
	Request        json.RawMessage `json:"request,omitempty"`
	Response       json.RawMessage `json:"response,omitempty"`
}

type AuditEvent struct {
	ID             string    `json:"id"`
	Timestamp      time.Time `json:"timestamp"`
	Method         string    `json:"method"`
	Path           string    `json:"path"`
	StatusCode     int       `json:"status_code"`
	DurationMS     int64     `json:"duration_ms"`
	RemoteAddr     string    `json:"remote_addr,omitempty"`
	CreatedByKeyID string    `json:"created_by_key_id,omitempty"`
	Action         string    `json:"action"`
}
