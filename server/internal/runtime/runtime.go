package runtime

import (
	"fmt"
	"sort"
	"strings"

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
	r := &Registry{adapters: map[string]Adapter{}}
	for _, a := range adapters {
		if a == nil {
			continue
		}
		_ = r.Add(a)
	}
	return r
}

func (r *Registry) Add(adapter Adapter) error {
	if adapter == nil {
		return fmt.Errorf("adapter is nil")
	}
	name := strings.TrimSpace(adapter.Name())
	if name == "" {
		return fmt.Errorf("adapter name is empty")
	}
	if _, exists := r.adapters[name]; exists {
		return fmt.Errorf("runtime already registered: %s", name)
	}
	r.adapters[name] = adapter
	return nil
}

func (r *Registry) Get(name string) (Adapter, bool) {
	a, ok := r.adapters[name]
	return a, ok
}

func (r *Registry) List() []model.RuntimeInfo {
	names := make([]string, 0, len(r.adapters))
	for name := range r.adapters {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]model.RuntimeInfo, 0, len(names))
	for _, name := range names {
		a := r.adapters[name]
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
