package executor

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/creack/pty"
	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

const defaultTerminalTerm = "xterm-256color"

func StartProjectTerminal(ctx context.Context, h model.Host, workdir string) (*InteractiveProcess, error) {
	if isLocalHostMode(h) {
		return startLocalProjectTerminal(ctx, workdir)
	}
	return startRemoteProjectTerminal(ctx, h, workdir)
}

func startLocalProjectTerminal(ctx context.Context, workdir string) (*InteractiveProcess, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	program, args := localTerminalShell()
	cmd := exec.Command(program, args...)
	if trimmed := strings.TrimSpace(workdir); trimmed != "" {
		cmd.Dir = trimmed
	}
	cmd.Env = append(os.Environ(), "TERM="+defaultTerminalTerm)

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, err
	}

	proc := &InteractiveProcess{
		command:  "local terminal " + program + " " + strings.Join(args, " "),
		cmd:      cmd,
		stdin:    ptmx,
		stdout:   ptmx,
		stderr:   nil,
		waitDone: make(chan struct{}),
	}
	go func() {
		<-ctx.Done()
		_ = proc.Close()
	}()
	return proc, nil
}

func startRemoteProjectTerminal(ctx context.Context, h model.Host, workdir string) (*InteractiveProcess, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	remoteCmd := renderRemoteTerminalCommand(workdir)
	sshArgs := buildSSHTransportArgs(h)
	sshArgs = append(sshArgs, "-tt", hostTarget(h), "--", "sh", "-lc", remoteCmd)
	cmd := exec.Command("ssh", sshArgs...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		return nil, err
	}

	proc := &InteractiveProcess{
		command:  "ssh " + strings.Join(sshArgs, " "),
		cmd:      cmd,
		stdin:    stdin,
		stdout:   stdout,
		stderr:   stderr,
		waitDone: make(chan struct{}),
	}
	go func() {
		<-ctx.Done()
		_ = proc.Close()
	}()
	return proc, nil
}

func localTerminalShell() (string, []string) {
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell, []string{"-li"}
	}
	if _, err := exec.LookPath("bash"); err == nil {
		return "bash", []string{"-li"}
	}
	return "sh", []string{"-li"}
}

func renderRemoteTerminalCommand(workdir string) string {
	shellBootstrap := strings.Join([]string{
		"export TERM=" + shellQuote(defaultTerminalTerm),
		"if [ -n \"${SHELL:-}\" ]; then exec \"$SHELL\" -li; fi",
		"if command -v bash >/dev/null 2>&1; then exec bash -li; fi",
		"exec sh -li",
	}, "; ")
	if trimmed := strings.TrimSpace(workdir); trimmed != "" {
		return fmt.Sprintf("cd %s && %s", shellQuote(trimmed), shellBootstrap)
	}
	return shellBootstrap
}

func copyReaderChunk(dst io.Writer, src io.Reader) error {
	_, err := io.Copy(dst, src)
	return err
}
