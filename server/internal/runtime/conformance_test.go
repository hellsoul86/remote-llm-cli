package runtime

import (
	"testing"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

func TestAdapterContractV2Conformance(t *testing.T) {
	fixtures := []struct {
		name    string
		adapter Adapter
		req     RunRequest
	}{
		{
			name:    "codex",
			adapter: NewCodexAdapter(),
			req:     RunRequest{Prompt: "fix tests"},
		},
		{
			name:    "claudecode",
			adapter: NewClaudeCodeAdapter(),
			req:     RunRequest{Prompt: "fix tests", ExtraArgs: []string{"--json"}},
		},
	}

	for _, fx := range fixtures {
		t.Run(fx.name, func(t *testing.T) {
			contractAware, ok := fx.adapter.(ContractAware)
			if !ok {
				t.Fatalf("adapter does not implement ContractAware")
			}
			contract := contractAware.Contract()
			if contract.Version != "v2" {
				t.Fatalf("contract version=%q want=v2", contract.Version)
			}
			assertProbeCommand(t, fx.adapter.BuildProbeCommand())

			spec, err := fx.adapter.BuildRunCommand(fx.req)
			if err != nil {
				t.Fatalf("build run command: %v", err)
			}
			assertRunCommandSpec(t, spec)

			if contract.PromptRequired {
				if _, err := fx.adapter.BuildRunCommand(RunRequest{}); err == nil {
					t.Fatalf("expected prompt-required validation error")
				}
			}
		})
	}
}

func TestRegistryListIncludesContractMetadata(t *testing.T) {
	r := NewRegistry(NewCodexAdapter(), NewClaudeCodeAdapter())
	list := r.List()
	if len(list) != 2 {
		t.Fatalf("len(list)=%d want=2", len(list))
	}
	for _, info := range list {
		if info.Contract == (model.RuntimeContract{}) {
			t.Fatalf("runtime %q has empty contract", info.Name)
		}
		if info.Contract.Version == "" {
			t.Fatalf("runtime %q missing contract version", info.Name)
		}
	}
}

func assertProbeCommand(t *testing.T, spec CommandSpec) {
	t.Helper()
	if spec.Program == "" {
		t.Fatalf("probe program should not be empty")
	}
}

func assertRunCommandSpec(t *testing.T, spec CommandSpec) {
	t.Helper()
	if spec.Program == "" {
		t.Fatalf("run program should not be empty")
	}
	if len(spec.Args) == 0 {
		t.Fatalf("run args should not be empty")
	}
}
