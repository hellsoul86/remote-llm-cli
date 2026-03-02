package runtime

import "testing"

func TestClaudeCodeBuildRunCommand(t *testing.T) {
	a := NewClaudeCodeAdapter()
	spec, err := a.BuildRunCommand(RunRequest{
		Prompt:    "summarize repo",
		ExtraArgs: []string{"--json"},
	})
	if err != nil {
		t.Fatalf("build command: %v", err)
	}
	if spec.Program != "claude" {
		t.Fatalf("program=%q want=claude", spec.Program)
	}
	if len(spec.Args) < 2 || spec.Args[0] != "exec" {
		t.Fatalf("unexpected args: %v", spec.Args)
	}
	if spec.Args[len(spec.Args)-1] != "--json" {
		t.Fatalf("extra args missing: %v", spec.Args)
	}
}

func TestClaudeCodeBuildRunCommandRequiresPrompt(t *testing.T) {
	a := NewClaudeCodeAdapter()
	if _, err := a.BuildRunCommand(RunRequest{}); err == nil {
		t.Fatalf("expected prompt validation error")
	}
}
