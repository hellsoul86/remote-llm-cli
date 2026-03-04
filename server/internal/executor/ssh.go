package executor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
)

const defaultMaxOutputBytes = 256 * 1024

const (
	HostConnectionModeSSH   = "ssh"
	HostConnectionModeLocal = "local"
)

type ErrorClass string

const (
	ErrorClassAuth      ErrorClass = "auth"
	ErrorClassNetwork   ErrorClass = "network"
	ErrorClassHostKey   ErrorClass = "host_key"
	ErrorClassCommand   ErrorClass = "command"
	ErrorClassToolchain ErrorClass = "toolchain"
	ErrorClassUnknown   ErrorClass = "unknown"
)

const (
	HostKeyPolicyAcceptNew    = "accept-new"
	HostKeyPolicyStrict       = "strict"
	HostKeyPolicyInsecureSkip = "insecure-ignore"
)

const (
	defaultSSHConnectTimeoutSec      = 10
	defaultSSHServerAliveIntervalSec = 30
	defaultSSHServerAliveCountMax    = 3
)

type ExecOptions struct {
	MaxStdoutBytes int
	MaxStderrBytes int
	OnStdoutChunk  func([]byte)
	OnStderrChunk  func([]byte)
}

func normalizeExecOptions(opts ExecOptions) ExecOptions {
	out := opts
	if out.MaxStdoutBytes <= 0 {
		out.MaxStdoutBytes = defaultMaxOutputBytes
	}
	if out.MaxStderrBytes <= 0 {
		out.MaxStderrBytes = defaultMaxOutputBytes
	}
	return out
}

type ExecResult struct {
	Command string `json:"command"`
	Stdout  string `json:"stdout"`
	Stderr  string `json:"stderr"`

	StdoutBytes     int  `json:"stdout_bytes"`
	StderrBytes     int  `json:"stderr_bytes"`
	StdoutTruncated bool `json:"stdout_truncated,omitempty"`
	StderrTruncated bool `json:"stderr_truncated,omitempty"`

	ExitCode   int           `json:"exit_code"`
	DurationMS int64         `json:"duration_ms"`
	StartedAt  time.Time     `json:"started_at"`
	FinishedAt time.Time     `json:"finished_at"`
	Duration   time.Duration `json:"-"`
}

type ClassifiedError struct {
	Class   ErrorClass `json:"class"`
	Hint    string     `json:"hint,omitempty"`
	Message string     `json:"message"`
	Cause   error      `json:"-"`
}

func (e *ClassifiedError) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	if e.Cause != nil {
		return e.Cause.Error()
	}
	return "execution failed"
}

func (e *ClassifiedError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func ErrorClassOf(err error) string {
	var classified *ClassifiedError
	if errors.As(err, &classified) {
		return string(classified.Class)
	}
	return ""
}

func ErrorHintOf(err error) string {
	var classified *ClassifiedError
	if errors.As(err, &classified) {
		return strings.TrimSpace(classified.Hint)
	}
	return ""
}

type PreflightCheck struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
	Hint   string `json:"hint,omitempty"`
}

type SSHPreflightReport struct {
	OK     bool             `json:"ok"`
	Checks []PreflightCheck `json:"checks"`
}

func RunViaSSH(ctx context.Context, h model.Host, spec runtime.CommandSpec, workdir string, opts ExecOptions) (ExecResult, error) {
	if isLocalHostMode(h) {
		return runViaLocalShell(ctx, spec, workdir, opts)
	}
	remoteCmd := renderRemoteCommand(spec, workdir)
	sshArgs := buildSSHArgs(h, remoteCmd)
	cmd := exec.CommandContext(ctx, "ssh", sshArgs...)
	res, err := runCommandStreaming(ctx, cmd, "ssh "+strings.Join(sshArgs, " "), opts)
	if err == nil {
		return res, nil
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		res.ExitCode = exitErr.ExitCode()
		return res, classifySSHRunError(err, res.ExitCode, res.Stderr)
	}
	res.ExitCode = -1
	return res, classifySSHRunError(err, res.ExitCode, res.Stderr)
}

func runViaLocalShell(ctx context.Context, spec runtime.CommandSpec, workdir string, opts ExecOptions) (ExecResult, error) {
	localCmd := renderRemoteCommand(spec, workdir)
	args := []string{"-lc", localCmd}
	cmd := exec.CommandContext(ctx, "sh", args...)
	res, err := runCommandStreaming(ctx, cmd, "local sh -lc "+shellQuote(localCmd), opts)
	if err == nil {
		return res, nil
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		res.ExitCode = exitErr.ExitCode()
		return res, classifyLocalRunError(err, res.ExitCode, res.Stderr)
	}
	res.ExitCode = -1
	return res, classifyLocalRunError(err, res.ExitCode, res.Stderr)
}

func runCommandStreaming(ctx context.Context, cmd *exec.Cmd, command string, opts ExecOptions) (ExecResult, error) {
	started := time.Now().UTC()
	normOpts := normalizeExecOptions(opts)
	stdoutBuffer := newLimitedBuffer(normOpts.MaxStdoutBytes)
	stderrBuffer := newLimitedBuffer(normOpts.MaxStderrBytes)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		finished := time.Now().UTC()
		return ExecResult{
			Command:    command,
			ExitCode:   -1,
			DurationMS: finished.Sub(started).Milliseconds(),
			StartedAt:  started,
			FinishedAt: finished,
		}, fmt.Errorf("stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		finished := time.Now().UTC()
		return ExecResult{
			Command:    command,
			ExitCode:   -1,
			DurationMS: finished.Sub(started).Milliseconds(),
			StartedAt:  started,
			FinishedAt: finished,
		}, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		finished := time.Now().UTC()
		return ExecResult{
			Command:    command,
			ExitCode:   -1,
			DurationMS: finished.Sub(started).Milliseconds(),
			StartedAt:  started,
			FinishedAt: finished,
		}, err
	}

	var wg sync.WaitGroup
	wg.Add(2)
	var stdoutErr error
	var stderrErr error

	go func() {
		defer wg.Done()
		stdoutErr = copyStreamToLimitedBuffer(stdoutPipe, stdoutBuffer, normOpts.OnStdoutChunk)
	}()
	go func() {
		defer wg.Done()
		stderrErr = copyStreamToLimitedBuffer(stderrPipe, stderrBuffer, normOpts.OnStderrChunk)
	}()

	// Drain both pipes before waiting on process completion to avoid
	// dropping fast-exit command output in local mode.
	wg.Wait()
	waitErr := cmd.Wait()
	if waitErr == nil {
		if stdoutErr != nil {
			waitErr = stdoutErr
		} else if stderrErr != nil {
			waitErr = stderrErr
		}
	}

	finished := time.Now().UTC()
	res := ExecResult{
		Command:         command,
		Stdout:          stdoutBuffer.String(),
		Stderr:          stderrBuffer.String(),
		StdoutBytes:     stdoutBuffer.TotalBytes(),
		StderrBytes:     stderrBuffer.TotalBytes(),
		StdoutTruncated: stdoutBuffer.Truncated(),
		StderrTruncated: stderrBuffer.Truncated(),
		ExitCode:        0,
		DurationMS:      finished.Sub(started).Milliseconds(),
		StartedAt:       started,
		FinishedAt:      finished,
	}
	return res, waitErr
}

func copyStreamToLimitedBuffer(src io.Reader, dst *limitedBuffer, onChunk func([]byte)) error {
	buf := make([]byte, 8192)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			if _, werr := dst.Write(chunk); werr != nil {
				return werr
			}
			if onChunk != nil {
				onChunk(chunk)
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, os.ErrClosed) {
				return nil
			}
			// Some environments report a closed pipe with this text instead of io.EOF.
			if strings.Contains(strings.ToLower(err.Error()), "file already closed") {
				return nil
			}
			return err
		}
	}
}

func renderRemoteCommand(spec runtime.CommandSpec, workdir string) string {
	parts := make([]string, 0, len(spec.Args)+2)
	parts = append(parts, shellQuote(spec.Program))
	for _, arg := range spec.Args {
		parts = append(parts, shellQuote(arg))
	}
	cmd := strings.Join(parts, " ")
	if workdir == "" {
		return "exec " + cmd
	}
	return "cd " + shellQuote(workdir) + " && exec " + cmd
}

func buildSSHArgs(h model.Host, remoteCommand string) []string {
	args := buildSSHTransportArgs(h)
	target := hostTarget(h)
	args = append(args, target, "--", "sh", "-lc", remoteCommand)
	return args
}

func buildSSHTransportArgs(h model.Host) []string {
	args := []string{
		"-o", "BatchMode=yes",
		"-o", fmt.Sprintf("ConnectTimeout=%d", clampInt(h.SSHConnectTimeoutSec, defaultSSHConnectTimeoutSec, 1, 300)),
		"-o", fmt.Sprintf("ServerAliveInterval=%d", clampInt(h.SSHServerAliveIntervalSec, defaultSSHServerAliveIntervalSec, 1, 300)),
		"-o", fmt.Sprintf("ServerAliveCountMax=%d", clampInt(h.SSHServerAliveCountMax, defaultSSHServerAliveCountMax, 1, 10)),
	}
	switch normalizeHostKeyPolicy(h.SSHHostKeyPolicy) {
	case HostKeyPolicyStrict:
		args = append(args, "-o", "StrictHostKeyChecking=yes")
	case HostKeyPolicyInsecureSkip:
		args = append(args, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null")
	default:
		args = append(args, "-o", "StrictHostKeyChecking=accept-new")
	}
	if h.Port > 0 {
		args = append(args, "-p", fmt.Sprintf("%d", h.Port))
	}
	if strings.TrimSpace(h.SSHProxyJump) != "" {
		args = append(args, "-J", strings.TrimSpace(h.SSHProxyJump))
	}
	if strings.TrimSpace(h.IdentityFile) != "" {
		args = append(args, "-i", strings.TrimSpace(h.IdentityFile), "-o", "IdentitiesOnly=yes")
	}
	return args
}

func normalizeHostKeyPolicy(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case HostKeyPolicyStrict:
		return HostKeyPolicyStrict
	case HostKeyPolicyInsecureSkip, "insecure", "off", "disabled":
		return HostKeyPolicyInsecureSkip
	default:
		return HostKeyPolicyAcceptNew
	}
}

func clampInt(v int, fallback int, min int, max int) int {
	if v <= 0 {
		v = fallback
	}
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

func RunSSHPreflight(h model.Host) SSHPreflightReport {
	if isLocalHostMode(h) {
		return runLocalPreflight()
	}
	checks := make([]PreflightCheck, 0, 4)
	sshPath, sshErr := exec.LookPath("ssh")
	checks = append(checks, PreflightCheck{
		Name:   "ssh_binary",
		OK:     sshErr == nil,
		Detail: toolDetail("ssh", sshPath, sshErr),
		Hint:   toolHint("ssh", sshErr),
	})
	rsyncPath, rsyncErr := exec.LookPath("rsync")
	checks = append(checks, PreflightCheck{
		Name:   "rsync_binary",
		OK:     rsyncErr == nil,
		Detail: toolDetail("rsync", rsyncPath, rsyncErr),
		Hint:   toolHint("rsync", rsyncErr),
	})

	identity := strings.TrimSpace(h.IdentityFile)
	if identity == "" {
		checks = append(checks, PreflightCheck{
			Name:   "identity_file",
			OK:     true,
			Detail: "not configured (agent/default ssh identities may be used)",
		})
	} else {
		stat, err := os.Stat(identity)
		if err != nil {
			checks = append(checks, PreflightCheck{
				Name:   "identity_file",
				OK:     false,
				Detail: err.Error(),
				Hint:   "set a valid local identity file path or remove identity_file to use ssh agent/default key",
			})
		} else {
			mode := stat.Mode().Perm()
			ok := mode&0o077 == 0
			hint := ""
			if !ok {
				hint = "restrict key permissions with chmod 600"
			}
			checks = append(checks, PreflightCheck{
				Name:   "identity_permissions",
				OK:     ok,
				Detail: fmt.Sprintf("%s mode=%#o", filepath.Base(identity), mode),
				Hint:   hint,
			})
		}
	}
	policy := normalizeHostKeyPolicy(h.SSHHostKeyPolicy)
	checks = append(checks, PreflightCheck{
		Name:   "host_key_policy",
		OK:     true,
		Detail: policy,
		Hint:   hostKeyPolicyHint(policy),
	})
	ok := true
	for _, item := range checks {
		if !item.OK {
			ok = false
			break
		}
	}
	return SSHPreflightReport{OK: ok, Checks: checks}
}

func runLocalPreflight() SSHPreflightReport {
	checks := make([]PreflightCheck, 0, 3)
	shellPath, shellErr := exec.LookPath("sh")
	checks = append(checks, PreflightCheck{
		Name:   "shell_binary",
		OK:     shellErr == nil,
		Detail: toolDetail("sh", shellPath, shellErr),
		Hint:   toolHint("sh", shellErr),
	})
	rsyncPath, rsyncErr := exec.LookPath("rsync")
	checks = append(checks, PreflightCheck{
		Name:   "rsync_binary",
		OK:     rsyncErr == nil,
		Detail: toolDetail("rsync", rsyncPath, rsyncErr),
		Hint:   toolHint("rsync", rsyncErr),
	})
	checks = append(checks, PreflightCheck{
		Name:   "connection_mode",
		OK:     true,
		Detail: HostConnectionModeLocal,
		Hint:   "local mode executes commands on the controller machine",
	})
	ok := true
	for _, item := range checks {
		if !item.OK {
			ok = false
			break
		}
	}
	return SSHPreflightReport{OK: ok, Checks: checks}
}

func toolDetail(name string, path string, err error) string {
	if err != nil {
		return err.Error()
	}
	return name + " found at " + path
}

func toolHint(name string, err error) string {
	if err == nil {
		return ""
	}
	return "install " + name + " in PATH on controller host"
}

func hostKeyPolicyHint(policy string) string {
	switch policy {
	case HostKeyPolicyStrict:
		return "strict mode requires known_hosts entry to exist beforehand"
	case HostKeyPolicyInsecureSkip:
		return "insecure mode disables host-key verification; avoid in production"
	default:
		return "accept-new trusts first connection and enforces key pinning afterwards"
	}
}

func classifySSHRunError(runErr error, exitCode int, stderr string) error {
	if runErr == nil {
		return nil
	}
	lower := strings.ToLower(stderr + "\n" + runErr.Error())
	if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) {
		return &ClassifiedError{
			Class:   ErrorClassNetwork,
			Hint:    "request timed out or was canceled; verify reachability and timeout settings",
			Message: fmt.Sprintf("ssh execution canceled: %v", runErr),
			Cause:   runErr,
		}
	}
	var execErr *exec.Error
	if errors.As(runErr, &execErr) {
		return &ClassifiedError{
			Class:   ErrorClassToolchain,
			Hint:    "install ssh client and verify PATH on controller host",
			Message: fmt.Sprintf("ssh binary execution failed: %v", runErr),
			Cause:   runErr,
		}
	}

	if exitCode != 255 && exitCode >= 0 {
		return &ClassifiedError{
			Class:   ErrorClassCommand,
			Hint:    "remote command exited non-zero; inspect stderr/stdout to debug runtime failure",
			Message: fmt.Sprintf("remote command failed: %v", runErr),
			Cause:   runErr,
		}
	}

	switch {
	case hasAny(lower, "permission denied", "publickey", "too many authentication failures", "sign_and_send_pubkey", "no such identity", "bad permissions"):
		return &ClassifiedError{
			Class:   ErrorClassAuth,
			Hint:    "verify ssh user, identity file, and authorized_keys on target",
			Message: fmt.Sprintf("ssh authentication failed: %v", runErr),
			Cause:   runErr,
		}
	case hasAny(lower, "host key verification failed", "remote host identification has changed", "offending ecdsa key", "offending rsa key", "strict host key checking"):
		return &ClassifiedError{
			Class:   ErrorClassHostKey,
			Hint:    "refresh known_hosts entry or adjust ssh_host_key_policy for first-time trust",
			Message: fmt.Sprintf("ssh host-key verification failed: %v", runErr),
			Cause:   runErr,
		}
	case hasAny(lower, "could not resolve hostname", "name or service not known", "temporary failure in name resolution", "connection timed out", "connection refused", "no route to host", "network is unreachable", "operation timed out", "connection closed"):
		return &ClassifiedError{
			Class:   ErrorClassNetwork,
			Hint:    "verify target host/port reachability, security group rules, and ProxyJump chain",
			Message: fmt.Sprintf("ssh network/connectivity failure: %v", runErr),
			Cause:   runErr,
		}
	default:
		return &ClassifiedError{
			Class:   ErrorClassUnknown,
			Hint:    "inspect stderr and run host probe for remediation hints",
			Message: fmt.Sprintf("ssh execution failed: %v", runErr),
			Cause:   runErr,
		}
	}
}

func classifyLocalRunError(runErr error, exitCode int, stderr string) error {
	if runErr == nil {
		return nil
	}
	if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) {
		return &ClassifiedError{
			Class:   ErrorClassCommand,
			Hint:    "local command timed out or was canceled; verify timeout settings",
			Message: fmt.Sprintf("local execution canceled: %v", runErr),
			Cause:   runErr,
		}
	}
	var execErr *exec.Error
	if errors.As(runErr, &execErr) {
		return &ClassifiedError{
			Class:   ErrorClassToolchain,
			Hint:    "install required local CLI binary on controller host",
			Message: fmt.Sprintf("local binary execution failed: %v", runErr),
			Cause:   runErr,
		}
	}
	if exitCode >= 0 {
		return &ClassifiedError{
			Class:   ErrorClassCommand,
			Hint:    "local command exited non-zero; inspect stderr/stdout",
			Message: fmt.Sprintf("local command failed: %v", runErr),
			Cause:   runErr,
		}
	}
	_ = stderr
	return &ClassifiedError{
		Class:   ErrorClassUnknown,
		Hint:    "inspect stderr and command output",
		Message: fmt.Sprintf("local execution failed: %v", runErr),
		Cause:   runErr,
	}
}

func classifyRsyncRunError(runErr error, exitCode int, stderr string) error {
	if runErr == nil {
		return nil
	}
	lower := strings.ToLower(stderr + "\n" + runErr.Error())
	if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) {
		return &ClassifiedError{
			Class:   ErrorClassNetwork,
			Hint:    "request timed out or was canceled; verify reachability and timeout settings",
			Message: fmt.Sprintf("rsync execution canceled: %v", runErr),
			Cause:   runErr,
		}
	}
	var execErr *exec.Error
	if errors.As(runErr, &execErr) {
		return &ClassifiedError{
			Class:   ErrorClassToolchain,
			Hint:    "install rsync/ssh clients and verify PATH on controller host",
			Message: fmt.Sprintf("rsync binary execution failed: %v", runErr),
			Cause:   runErr,
		}
	}
	switch {
	case hasAny(lower, "permission denied", "publickey", "authentication failed", "no such identity", "failed to authenticate"):
		return &ClassifiedError{
			Class:   ErrorClassAuth,
			Hint:    "verify ssh user, identity file, and target permissions",
			Message: fmt.Sprintf("rsync authentication failed: %v", runErr),
			Cause:   runErr,
		}
	case hasAny(lower, "host key verification failed", "remote host identification has changed", "strict host key checking"):
		return &ClassifiedError{
			Class:   ErrorClassHostKey,
			Hint:    "refresh known_hosts entry or adjust ssh_host_key_policy for first-time trust",
			Message: fmt.Sprintf("rsync host-key verification failed: %v", runErr),
			Cause:   runErr,
		}
	case hasAny(lower, "could not resolve hostname", "name or service not known", "connection timed out", "connection refused", "no route to host", "network is unreachable"):
		return &ClassifiedError{
			Class:   ErrorClassNetwork,
			Hint:    "verify target host/port reachability and ssh proxy/jump path",
			Message: fmt.Sprintf("rsync network/connectivity failure: %v", runErr),
			Cause:   runErr,
		}
	case exitCode >= 0:
		return &ClassifiedError{
			Class:   ErrorClassCommand,
			Hint:    "rsync exited non-zero; inspect stderr for transfer path/permission details",
			Message: fmt.Sprintf("rsync command failed: %v", runErr),
			Cause:   runErr,
		}
	default:
		return &ClassifiedError{
			Class:   ErrorClassUnknown,
			Hint:    "inspect stderr and run host probe for remediation hints",
			Message: fmt.Sprintf("rsync execution failed: %v", runErr),
			Cause:   runErr,
		}
	}
}

func hasAny(text string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(text, sub) {
			return true
		}
	}
	return false
}

func isLocalHostMode(h model.Host) bool {
	return normalizeHostConnectionMode(h.ConnectionMode) == HostConnectionModeLocal
}

func normalizeHostConnectionMode(v string) string {
	mode := strings.ToLower(strings.TrimSpace(v))
	if mode == "" {
		return HostConnectionModeSSH
	}
	if mode == HostConnectionModeLocal {
		return HostConnectionModeLocal
	}
	return HostConnectionModeSSH
}

func hostTarget(h model.Host) string {
	if strings.TrimSpace(h.User) == "" {
		return h.Host
	}
	return h.User + "@" + h.Host
}

func shellQuote(v string) string {
	if v == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(v, "'", "'\"'\"'") + "'"
}

type limitedBuffer struct {
	max       int
	total     int
	truncated bool
	buf       bytes.Buffer
}

func newLimitedBuffer(max int) *limitedBuffer {
	return &limitedBuffer{max: max}
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.total += len(p)
	if b.max <= 0 {
		return len(p), nil
	}

	remaining := b.max - b.buf.Len()
	if remaining > 0 {
		n := len(p)
		if n > remaining {
			n = remaining
		}
		if _, err := io.Copy(&b.buf, bytes.NewReader(p[:n])); err != nil {
			return 0, err
		}
	}
	if len(p) > remaining {
		b.truncated = true
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	return b.buf.String()
}

func (b *limitedBuffer) TotalBytes() int {
	return b.total
}

func (b *limitedBuffer) Truncated() bool {
	return b.truncated
}
