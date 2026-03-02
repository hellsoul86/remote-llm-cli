package runtime

import (
	"fmt"
	"strings"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

type CodexAdapter struct{}

func NewCodexAdapter() *CodexAdapter { return &CodexAdapter{} }

func (a *CodexAdapter) Name() string { return "codex" }

func (a *CodexAdapter) Capabilities() model.RuntimeCapabilities {
	return model.RuntimeCapabilities{
		SupportsNonInteractiveExec: true,
		SupportsInteractiveSession: false,
		SupportsStructuredOutput:   true,
		SupportsFilePatchMode:      false,
		SupportsCostMetrics:        false,
	}
}

func (a *CodexAdapter) BuildProbeCommand() CommandSpec {
	return CommandSpec{Program: "codex", Args: []string{"--version"}}
}

func (a *CodexAdapter) BuildRunCommand(req RunRequest) (CommandSpec, error) {
	opts := codexDefaults(req.Codex)
	mode := opts.Mode
	if mode == "" {
		mode = CodexRunModeExec
	}

	args := []string{"exec"}
	switch mode {
	case CodexRunModeExec:
	case CodexRunModeResume:
		args = append(args, "resume")
	case CodexRunModeReview:
		args = append(args, "review")
	default:
		return CommandSpec{}, fmt.Errorf("unsupported codex mode: %q", mode)
	}

	if err := appendCodexOptions(&args, opts, mode); err != nil {
		return CommandSpec{}, err
	}
	if err := appendModeArgs(&args, req.Prompt, opts, mode); err != nil {
		return CommandSpec{}, err
	}

	// Keep backward compatibility: caller-provided extra args are appended.
	args = append(args, req.ExtraArgs...)
	return CommandSpec{Program: "codex", Args: args}, nil
}

func codexDefaults(in *CodexRunOptions) CodexRunOptions {
	if in == nil {
		return CodexRunOptions{Mode: CodexRunModeExec}
	}
	out := *in
	if out.Mode == "" {
		out.Mode = CodexRunModeExec
	}
	return out
}

func appendCodexOptions(args *[]string, opts CodexRunOptions, mode CodexRunMode) error {
	appendRepeatableFlag(args, "-c", opts.Config)
	appendRepeatableFlag(args, "--enable", opts.Enable)
	appendRepeatableFlag(args, "--disable", opts.Disable)

	if v := strings.TrimSpace(opts.Model); v != "" {
		*args = append(*args, "--model", v)
	}
	if opts.FullAuto {
		*args = append(*args, "--full-auto")
	}
	if opts.DangerouslyBypassApprovalsAndSandbox {
		*args = append(*args, "--dangerously-bypass-approvals-and-sandbox")
	}
	if opts.SkipGitRepoCheck {
		*args = append(*args, "--skip-git-repo-check")
	}
	if opts.Ephemeral {
		*args = append(*args, "--ephemeral")
	}
	if opts.JSONOutput {
		*args = append(*args, "--json")
	}
	if v := strings.TrimSpace(opts.OutputLastMessageFile); v != "" {
		*args = append(*args, "--output-last-message", v)
	}

	switch mode {
	case CodexRunModeExec:
		if err := appendExecOnlyOptions(args, opts); err != nil {
			return err
		}
	case CodexRunModeResume:
		if err := validateResumeOnlyOptions(opts); err != nil {
			return err
		}
		appendRepeatableFlag(args, "--image", opts.Images)
	case CodexRunModeReview:
		if err := appendReviewOnlyOptions(args, opts); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported codex mode: %q", mode)
	}
	return nil
}

func appendExecOnlyOptions(args *[]string, opts CodexRunOptions) error {
	if v := strings.TrimSpace(opts.Profile); v != "" {
		*args = append(*args, "--profile", v)
	}
	if v := strings.TrimSpace(opts.Sandbox); v != "" {
		if err := validateSandbox(v); err != nil {
			return err
		}
		*args = append(*args, "--sandbox", v)
	}
	if opts.OSS {
		*args = append(*args, "--oss")
	}
	if v := strings.TrimSpace(opts.LocalProvider); v != "" {
		*args = append(*args, "--local-provider", v)
	}
	appendRepeatableFlag(args, "--add-dir", opts.AddDirs)
	appendRepeatableFlag(args, "--image", opts.Images)
	if v := strings.TrimSpace(opts.Color); v != "" {
		if err := validateColor(v); err != nil {
			return err
		}
		*args = append(*args, "--color", v)
	}
	if opts.ProgressCursor {
		*args = append(*args, "--progress-cursor")
	}
	return nil
}

func validateResumeOnlyOptions(opts CodexRunOptions) error {
	if strings.TrimSpace(opts.Profile) != "" {
		return fmt.Errorf("profile is not supported in codex resume mode")
	}
	if strings.TrimSpace(opts.Sandbox) != "" {
		return fmt.Errorf("sandbox is not supported in codex resume mode")
	}
	if opts.OSS {
		return fmt.Errorf("oss is not supported in codex resume mode")
	}
	if strings.TrimSpace(opts.LocalProvider) != "" {
		return fmt.Errorf("local_provider is not supported in codex resume mode")
	}
	if len(opts.AddDirs) > 0 {
		return fmt.Errorf("add_dirs is not supported in codex resume mode")
	}
	if strings.TrimSpace(opts.Color) != "" {
		return fmt.Errorf("color is not supported in codex resume mode")
	}
	if opts.ProgressCursor {
		return fmt.Errorf("progress_cursor is not supported in codex resume mode")
	}
	return nil
}

func appendReviewOnlyOptions(args *[]string, opts CodexRunOptions) error {
	if strings.TrimSpace(opts.Profile) != "" {
		return fmt.Errorf("profile is not supported in codex review mode")
	}
	if strings.TrimSpace(opts.Sandbox) != "" {
		return fmt.Errorf("sandbox is not supported in codex review mode")
	}
	if opts.OSS {
		return fmt.Errorf("oss is not supported in codex review mode")
	}
	if strings.TrimSpace(opts.LocalProvider) != "" {
		return fmt.Errorf("local_provider is not supported in codex review mode")
	}
	if len(opts.AddDirs) > 0 {
		return fmt.Errorf("add_dirs is not supported in codex review mode")
	}
	if len(opts.Images) > 0 {
		return fmt.Errorf("images is not supported in codex review mode")
	}
	if strings.TrimSpace(opts.Color) != "" {
		return fmt.Errorf("color is not supported in codex review mode")
	}
	if opts.ProgressCursor {
		return fmt.Errorf("progress_cursor is not supported in codex review mode")
	}
	if opts.ReviewUncommitted {
		*args = append(*args, "--uncommitted")
	}
	if v := strings.TrimSpace(opts.ReviewBase); v != "" {
		*args = append(*args, "--base", v)
	}
	if v := strings.TrimSpace(opts.ReviewCommit); v != "" {
		*args = append(*args, "--commit", v)
	}
	if v := strings.TrimSpace(opts.ReviewTitle); v != "" {
		*args = append(*args, "--title", v)
	}
	return nil
}

func appendModeArgs(args *[]string, prompt string, opts CodexRunOptions, mode CodexRunMode) error {
	trimmedPrompt := strings.TrimSpace(prompt)
	switch mode {
	case CodexRunModeExec:
		if trimmedPrompt == "" {
			return fmt.Errorf("prompt is required for codex exec mode")
		}
		*args = append(*args, trimmedPrompt)
		return nil
	case CodexRunModeResume:
		hasSessionID := strings.TrimSpace(opts.SessionID) != ""
		if opts.ResumeLast && hasSessionID {
			return fmt.Errorf("codex resume accepts only one selector: resume_last or session_id")
		}
		if !opts.ResumeLast && !hasSessionID {
			return fmt.Errorf("codex resume requires resume_last=true or session_id")
		}
		if opts.ResumeLast {
			*args = append(*args, "--last")
		} else {
			*args = append(*args, strings.TrimSpace(opts.SessionID))
		}
		if trimmedPrompt != "" {
			*args = append(*args, trimmedPrompt)
		}
		return nil
	case CodexRunModeReview:
		if trimmedPrompt != "" {
			*args = append(*args, trimmedPrompt)
		}
		return nil
	default:
		return fmt.Errorf("unsupported codex mode: %q", mode)
	}
}

func appendRepeatableFlag(args *[]string, flag string, values []string) {
	for _, v := range values {
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			continue
		}
		*args = append(*args, flag, trimmed)
	}
}

func validateSandbox(v string) error {
	switch v {
	case "read-only", "workspace-write", "danger-full-access":
		return nil
	default:
		return fmt.Errorf("invalid codex sandbox: %q", v)
	}
}

func validateColor(v string) error {
	switch v {
	case "always", "never", "auto":
		return nil
	default:
		return fmt.Errorf("invalid codex color: %q", v)
	}
}
