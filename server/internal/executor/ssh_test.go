package executor

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
	"github.com/hellsoul86/remote-llm-cli/server/internal/runtime"
)

func TestLimitedBufferTruncation(t *testing.T) {
	b := newLimitedBuffer(5)
	n, err := b.Write([]byte("hello-world"))
	if err != nil {
		t.Fatalf("write error: %v", err)
	}
	if n != 11 {
		t.Fatalf("write n=%d want=11", n)
	}
	if b.String() != "hello" {
		t.Fatalf("buffer=%q want=hello", b.String())
	}
	if !b.Truncated() {
		t.Fatalf("expected truncated=true")
	}
	if b.TotalBytes() != 11 {
		t.Fatalf("total=%d want=11", b.TotalBytes())
	}
}

func TestNormalizeExecOptions(t *testing.T) {
	opts := normalizeExecOptions(ExecOptions{})
	if opts.MaxStdoutBytes <= 0 || opts.MaxStderrBytes <= 0 {
		t.Fatalf("normalized max bytes should be > 0: %+v", opts)
	}
}

func TestBuildSSHTransportArgsDefaults(t *testing.T) {
	args := buildSSHTransportArgs(model.Host{})
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"BatchMode=yes",
		"ConnectTimeout=10",
		"ServerAliveInterval=30",
		"ServerAliveCountMax=3",
		"StrictHostKeyChecking=accept-new",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in args: %v", want, args)
		}
	}
}

func TestBuildSSHTransportArgsAdvanced(t *testing.T) {
	h := model.Host{
		Port:                      2222,
		IdentityFile:              "/tmp/id_ed25519",
		SSHProxyJump:              "jump@bastion:22",
		SSHHostKeyPolicy:          "strict",
		SSHConnectTimeoutSec:      20,
		SSHServerAliveIntervalSec: 40,
		SSHServerAliveCountMax:    5,
	}
	args := buildSSHTransportArgs(h)
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"-p 2222",
		"-i /tmp/id_ed25519",
		"IdentitiesOnly=yes",
		"-J jump@bastion:22",
		"StrictHostKeyChecking=yes",
		"ConnectTimeout=20",
		"ServerAliveInterval=40",
		"ServerAliveCountMax=5",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in args: %v", want, args)
		}
	}
}

func TestClassifySSHRunError(t *testing.T) {
	err := classifySSHRunError(errors.New("exit"), 255, "Permission denied (publickey).")
	if ErrorClassOf(err) != string(ErrorClassAuth) {
		t.Fatalf("class=%q want=%q", ErrorClassOf(err), ErrorClassAuth)
	}
	err = classifySSHRunError(errors.New("exit"), 255, "Host key verification failed")
	if ErrorClassOf(err) != string(ErrorClassHostKey) {
		t.Fatalf("class=%q want=%q", ErrorClassOf(err), ErrorClassHostKey)
	}
	err = classifySSHRunError(errors.New("exit"), 1, "tool returned non-zero")
	if ErrorClassOf(err) != string(ErrorClassCommand) {
		t.Fatalf("class=%q want=%q", ErrorClassOf(err), ErrorClassCommand)
	}
}

func TestRunSSHPreflightIdentityFileMissing(t *testing.T) {
	report := RunSSHPreflight(model.Host{IdentityFile: "/tmp/remote-llm-cli-missing-key"})
	found := false
	for _, check := range report.Checks {
		if check.Name == "identity_file" {
			found = true
			if check.OK {
				t.Fatalf("identity_file should fail when missing")
			}
		}
	}
	if !found {
		t.Fatalf("identity_file check not found: %+v", report.Checks)
	}
}

func TestRunViaSSHLocalMode(t *testing.T) {
	res, err := RunViaSSH(
		context.Background(),
		model.Host{ConnectionMode: "local"},
		runtime.CommandSpec{Program: "echo", Args: []string{"hello-local"}},
		"",
		ExecOptions{},
	)
	if err != nil {
		t.Fatalf("RunViaSSH local err=%v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit=%d want=0", res.ExitCode)
	}
	if !strings.Contains(res.Stdout, "hello-local") {
		t.Fatalf("stdout=%q should contain hello-local", res.Stdout)
	}
	if !strings.HasPrefix(res.Command, "local sh -lc ") {
		t.Fatalf("command=%q should be local mode", res.Command)
	}
}

func TestRunSSHPreflightLocalModeSkipsSSH(t *testing.T) {
	report := RunSSHPreflight(model.Host{ConnectionMode: "local"})
	if len(report.Checks) == 0 {
		t.Fatalf("expected local preflight checks")
	}
	foundMode := false
	for _, check := range report.Checks {
		if check.Name == "connection_mode" && check.Detail == "local" {
			foundMode = true
		}
		if check.Name == "ssh_binary" {
			t.Fatalf("local mode preflight should not include ssh_binary check")
		}
	}
	if !foundMode {
		t.Fatalf("connection_mode check missing: %+v", report.Checks)
	}
}
