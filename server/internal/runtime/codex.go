package runtime

import (
	"fmt"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

type CodexAdapter struct{}

func NewCodexAdapter() *CodexAdapter { return &CodexAdapter{} }

func (a *CodexAdapter) Name() string { return "codex" }

func (a *CodexAdapter) Capabilities() model.RuntimeCapabilities {
	return model.RuntimeCapabilities{
		SupportsNonInteractiveExec: true,
		SupportsInteractiveSession: false,
		SupportsStructuredOutput:   false,
		SupportsFilePatchMode:      false,
		SupportsCostMetrics:        false,
	}
}

func (a *CodexAdapter) BuildProbeCommand() CommandSpec {
	return CommandSpec{Program: "codex", Args: []string{"--version"}}
}

func (a *CodexAdapter) BuildRunCommand(req RunRequest) (CommandSpec, error) {
	if req.Prompt == "" {
		return CommandSpec{}, fmt.Errorf("prompt is required")
	}
	args := []string{"exec", req.Prompt}
	args = append(args, req.ExtraArgs...)
	return CommandSpec{Program: "codex", Args: args}, nil
}
