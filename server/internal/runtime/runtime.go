package runtime

import (
	"fmt"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

type RunRequest struct {
	Prompt    string   `json:"prompt"`
	Workdir   string   `json:"workdir,omitempty"`
	ExtraArgs []string `json:"extra_args,omitempty"`
}

type CommandSpec struct {
	Program string
	Args    []string
}

type Adapter interface {
	Name() string
	Capabilities() model.RuntimeCapabilities
	BuildRunCommand(req RunRequest) (CommandSpec, error)
	BuildProbeCommand() CommandSpec
}

type Registry struct {
	adapters map[string]Adapter
}

func NewRegistry(adapters ...Adapter) *Registry {
	m := make(map[string]Adapter, len(adapters))
	for _, a := range adapters {
		m[a.Name()] = a
	}
	return &Registry{adapters: m}
}

func (r *Registry) Get(name string) (Adapter, bool) {
	a, ok := r.adapters[name]
	return a, ok
}

func (r *Registry) List() []model.RuntimeInfo {
	out := make([]model.RuntimeInfo, 0, len(r.adapters))
	for _, a := range r.adapters {
		out = append(out, model.RuntimeInfo{
			Name:         a.Name(),
			Capabilities: a.Capabilities(),
		})
	}
	return out
}

func ValidateRuntime(name string) error {
	if name == "" {
		return fmt.Errorf("runtime is required")
	}
	return nil
}
