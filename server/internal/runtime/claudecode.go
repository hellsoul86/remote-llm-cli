package runtime

import (
	"fmt"
	"strings"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

type ClaudeCodeAdapter struct{}

func NewClaudeCodeAdapter() *ClaudeCodeAdapter { return &ClaudeCodeAdapter{} }

func (a *ClaudeCodeAdapter) Name() string { return "claudecode" }

func (a *ClaudeCodeAdapter) Capabilities() model.RuntimeCapabilities {
	return model.RuntimeCapabilities{
		SupportsNonInteractiveExec: true,
		SupportsInteractiveSession: false,
		SupportsStructuredOutput:   false,
		SupportsFilePatchMode:      false,
		SupportsCostMetrics:        false,
	}
}

func (a *ClaudeCodeAdapter) Contract() model.RuntimeContract {
	return model.RuntimeContract{
		Version:           "v2",
		PromptRequired:    true,
		SupportsWorkdir:   true,
		SupportsExtraArgs: true,
	}
}

func (a *ClaudeCodeAdapter) BuildProbeCommand() CommandSpec {
	return CommandSpec{Program: "claude", Args: []string{"--version"}}
}

func (a *ClaudeCodeAdapter) BuildRunCommand(req RunRequest) (CommandSpec, error) {
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return CommandSpec{}, fmt.Errorf("prompt is required")
	}
	args := []string{"exec", prompt}
	args = append(args, req.ExtraArgs...)
	return CommandSpec{Program: "claude", Args: args}, nil
}
