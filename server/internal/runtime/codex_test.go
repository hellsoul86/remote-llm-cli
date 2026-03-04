package runtime

import "testing"

func hasArgPair(args []string, flag string, value string) bool {
	for index := 0; index < len(args)-1; index += 1 {
		if args[index] != flag {
			continue
		}
		if args[index+1] == value {
			return true
		}
	}
	return false
}

func hasArg(args []string, target string) bool {
	for _, arg := range args {
		if arg == target {
			return true
		}
	}
	return false
}

func TestCodexBuildRunCommandExecWithOptions(t *testing.T) {
	a := NewCodexAdapter()
	spec, err := a.BuildRunCommand(RunRequest{
		Prompt: "fix tests",
		Codex: &CodexRunOptions{
			Mode:                  CodexRunModeExec,
			Model:                 "gpt-5",
			AskForApproval:        "on-request",
			Search:                true,
			Sandbox:               "workspace-write",
			JSONOutput:            true,
			SkipGitRepoCheck:      true,
			Ephemeral:             true,
			Config:                []string{"model_reasoning_effort=\"high\""},
			Enable:                []string{"streaming_tool_output"},
			AddDirs:               []string{"/srv/work"},
			OutputLastMessageFile: "/tmp/last.txt",
		},
	})
	if err != nil {
		t.Fatalf("build command: %v", err)
	}
	if spec.Program != "codex" {
		t.Fatalf("program=%q want=codex", spec.Program)
	}
	if len(spec.Args) == 0 || spec.Args[0] != "exec" {
		t.Fatalf("args should start with exec: %v", spec.Args)
	}
	if !hasArgPair(spec.Args, "--ask-for-approval", "on-request") {
		t.Fatalf("missing ask-for-approval args: %v", spec.Args)
	}
	if !hasArg(spec.Args, "--search") {
		t.Fatalf("missing --search arg: %v", spec.Args)
	}
}

func TestCodexBuildRunCommandResume(t *testing.T) {
	a := NewCodexAdapter()
	spec, err := a.BuildRunCommand(RunRequest{
		Prompt: "continue",
		Codex: &CodexRunOptions{
			Mode:       CodexRunModeResume,
			SessionID:  "11111111-1111-1111-1111-111111111111",
			JSONOutput: true,
		},
	})
	if err != nil {
		t.Fatalf("build command: %v", err)
	}
	wantPrefix := []string{"exec", "resume"}
	if len(spec.Args) < len(wantPrefix) {
		t.Fatalf("args too short: %v", spec.Args)
	}
	for i := range wantPrefix {
		if spec.Args[i] != wantPrefix[i] {
			t.Fatalf("args[%d]=%q want=%q", i, spec.Args[i], wantPrefix[i])
		}
	}
}

func TestCodexBuildRunCommandResumeSelectorValidation(t *testing.T) {
	a := NewCodexAdapter()
	_, err := a.BuildRunCommand(RunRequest{
		Codex: &CodexRunOptions{
			Mode:       CodexRunModeResume,
			ResumeLast: true,
			SessionID:  "abc",
		},
	})
	if err == nil {
		t.Fatalf("expected selector validation error")
	}
}

func TestCodexBuildRunCommandReviewWithPrompt(t *testing.T) {
	a := NewCodexAdapter()
	spec, err := a.BuildRunCommand(RunRequest{
		Prompt: "focus on security",
		Codex: &CodexRunOptions{
			Mode:                                 CodexRunModeReview,
			ReviewUncommitted:                    true,
			ReviewBase:                           "main",
			ReviewTitle:                          "CI review",
			DangerouslyBypassApprovalsAndSandbox: true,
		},
	})
	if err != nil {
		t.Fatalf("build command: %v", err)
	}
	if len(spec.Args) < 2 || spec.Args[0] != "exec" || spec.Args[1] != "review" {
		t.Fatalf("unexpected args: %v", spec.Args)
	}
}

func TestCodexBuildRunCommandModeSpecificValidation(t *testing.T) {
	a := NewCodexAdapter()
	_, err := a.BuildRunCommand(RunRequest{
		Codex: &CodexRunOptions{
			Mode:    CodexRunModeReview,
			Sandbox: "workspace-write",
		},
	})
	if err == nil {
		t.Fatalf("expected review mode option validation error")
	}
}

func TestCodexBuildRunCommandAskForApprovalValidation(t *testing.T) {
	a := NewCodexAdapter()
	_, err := a.BuildRunCommand(RunRequest{
		Prompt: "hello",
		Codex: &CodexRunOptions{
			Mode:           CodexRunModeExec,
			AskForApproval: "invalid-policy",
		},
	})
	if err == nil {
		t.Fatalf("expected ask_for_approval validation error")
	}
}
