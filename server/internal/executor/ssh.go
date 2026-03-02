package executor

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
)

type ExecResult struct {
	Command    string        `json:"command"`
	Stdout     string        `json:"stdout"`
	Stderr     string        `json:"stderr"`
	ExitCode   int           `json:"exit_code"`
	DurationMS int64         `json:"duration_ms"`
	StartedAt  time.Time     `json:"started_at"`
	FinishedAt time.Time     `json:"finished_at"`
	Duration   time.Duration `json:"-"`
}

func RunViaSSH(ctx context.Context, h model.Host, spec runtime.CommandSpec, workdir string) (ExecResult, error) {
	started := time.Now().UTC()
	remoteCmd := renderRemoteCommand(spec, workdir)
	sshArgs := buildSSHArgs(h, remoteCmd)
	cmd := exec.CommandContext(ctx, "ssh", sshArgs...)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	finished := time.Now().UTC()
	res := ExecResult{
		Command:    "ssh " + strings.Join(sshArgs, " "),
		Stdout:     stdout.String(),
		Stderr:     stderr.String(),
		ExitCode:   0,
		DurationMS: finished.Sub(started).Milliseconds(),
		StartedAt:  started,
		FinishedAt: finished,
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
	args := []string{"-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"}
	if h.Port > 0 {
		args = append(args, "-p", fmt.Sprintf("%d", h.Port))
	}
	if h.IdentityFile != "" {
		args = append(args, "-i", h.IdentityFile)
	}
	target := h.Host
	if h.User != "" {
		target = h.User + "@" + h.Host
	}
	args = append(args, target, "--", "sh", "-lc", remoteCommand)
	return args
}

func shellQuote(v string) string {
	if v == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(v, "'", "'\"'\"'") + "'"
}
