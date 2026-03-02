package executor

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

type SyncOptions struct {
	Delete   bool
	Excludes []string
}

func RunRsyncViaSSH(
	ctx context.Context,
	h model.Host,
	src string,
	dst string,
	opts SyncOptions,
	execOpts ExecOptions,
) (ExecResult, error) {
	started := time.Now().UTC()
	args := buildRsyncArgs(h, src, dst, opts)
	cmd := exec.CommandContext(ctx, "rsync", args...)

	normExecOpts := normalizeExecOptions(execOpts)
	stdoutBuffer := newLimitedBuffer(normExecOpts.MaxStdoutBytes)
	stderrBuffer := newLimitedBuffer(normExecOpts.MaxStderrBytes)
	cmd.Stdout = stdoutBuffer
	cmd.Stderr = stderrBuffer

	err := cmd.Run()
	finished := time.Now().UTC()
	res := ExecResult{
		Command:         "rsync " + strings.Join(args, " "),
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
		return res, classifyRsyncRunError(err, res.ExitCode, res.Stderr)
	}
	res.ExitCode = -1
	return res, classifyRsyncRunError(err, res.ExitCode, res.Stderr)
}

func buildRsyncArgs(h model.Host, src string, dst string, opts SyncOptions) []string {
	args := []string{"-az"}
	if opts.Delete {
		args = append(args, "--delete")
	}
	for _, ex := range opts.Excludes {
		pat := strings.TrimSpace(ex)
		if pat == "" {
			continue
		}
		args = append(args, "--exclude", pat)
	}
	args = append(args, "-e", buildRsyncSSHCommand(h))
	args = append(args, src, hostTarget(h)+":"+dst)
	return args
}

func buildRsyncSSHCommand(h model.Host) string {
	parts := []string{"ssh"}
	for _, arg := range buildSSHTransportArgs(h) {
		parts = append(parts, shellQuote(arg))
	}
	return strings.Join(parts, " ")
}
