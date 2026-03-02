package executor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
)

const defaultMaxOutputBytes = 256 * 1024

type ExecOptions struct {
	MaxStdoutBytes int
	MaxStderrBytes int
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

func RunViaSSH(ctx context.Context, h model.Host, spec runtime.CommandSpec, workdir string, opts ExecOptions) (ExecResult, error) {
	started := time.Now().UTC()
	remoteCmd := renderRemoteCommand(spec, workdir)
	sshArgs := buildSSHArgs(h, remoteCmd)
	cmd := exec.CommandContext(ctx, "ssh", sshArgs...)

	normOpts := normalizeExecOptions(opts)
	stdoutBuffer := newLimitedBuffer(normOpts.MaxStdoutBytes)
	stderrBuffer := newLimitedBuffer(normOpts.MaxStderrBytes)
	cmd.Stdout = stdoutBuffer
	cmd.Stderr = stderrBuffer

	err := cmd.Run()
	finished := time.Now().UTC()
	res := ExecResult{
		Command:         "ssh " + strings.Join(sshArgs, " "),
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
	if err == nil {
		return res, nil
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		res.ExitCode = exitErr.ExitCode()
		return res, fmt.Errorf("remote command failed: %w", err)
	}
	res.ExitCode = -1
	return res, fmt.Errorf("ssh execution failed: %w", err)
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
	args := []string{"-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"}
	if h.Port > 0 {
		args = append(args, "-p", fmt.Sprintf("%d", h.Port))
	}
	if h.IdentityFile != "" {
		args = append(args, "-i", h.IdentityFile)
	}
	return args
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
