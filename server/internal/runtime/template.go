package runtime

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/hellsoul86/remote-llm-cli/server/internal/model"
)

const (
	placeholderPrompt    = "{{prompt}}"
	placeholderWorkdir   = "{{workdir}}"
	placeholderExtraArgs = "{{extra_args}}"
)

type TemplateConfig struct {
	Runtimes []TemplateRuntimeDefinition `json:"runtimes"`
}

type TemplateRuntimeDefinition struct {
	Name            string                    `json:"name"`
	Program         string                    `json:"program"`
	RunArgs         []string                  `json:"run_args"`
	ProbeProgram    string                    `json:"probe_program,omitempty"`
	ProbeArgs       []string                  `json:"probe_args,omitempty"`
	Capabilities    model.RuntimeCapabilities `json:"capabilities,omitempty"`
	AppendExtraArgs *bool                     `json:"append_extra_args,omitempty"`
}

type TemplateAdapter struct {
	def TemplateRuntimeDefinition
}

func NewTemplateAdapter(def TemplateRuntimeDefinition) (*TemplateAdapter, error) {
	norm, err := normalizeTemplateDefinition(def)
	if err != nil {
		return nil, err
	}
	return &TemplateAdapter{def: norm}, nil
}

func (a *TemplateAdapter) Name() string {
	return a.def.Name
}

func (a *TemplateAdapter) Capabilities() model.RuntimeCapabilities {
	return a.def.Capabilities
}

func (a *TemplateAdapter) Contract() model.RuntimeContract {
	return model.RuntimeContract{
		Version:           "v2",
		PromptRequired:    true,
		SupportsWorkdir:   true,
		SupportsExtraArgs: true,
	}
}

func (a *TemplateAdapter) BuildRunCommand(req RunRequest) (CommandSpec, error) {
	if strings.TrimSpace(req.Prompt) == "" {
		return CommandSpec{}, fmt.Errorf("prompt is required")
	}
	args, err := renderTemplateArgs(a.def.RunArgs, req, a.appendExtraArgsEnabled())
	if err != nil {
		return CommandSpec{}, err
	}
	return CommandSpec{
		Program: a.def.Program,
		Args:    args,
	}, nil
}

func (a *TemplateAdapter) BuildProbeCommand() CommandSpec {
	program := a.def.ProbeProgram
	if strings.TrimSpace(program) == "" {
		program = a.def.Program
	}
	args := a.def.ProbeArgs
	if len(args) == 0 {
		args = []string{"--version"}
	}
	out := make([]string, len(args))
	copy(out, args)
	return CommandSpec{
		Program: program,
		Args:    out,
	}
}

func (a *TemplateAdapter) appendExtraArgsEnabled() bool {
	if a.def.AppendExtraArgs == nil {
		return true
	}
	return *a.def.AppendExtraArgs
}

func LoadTemplateAdaptersFromFile(path string) ([]Adapter, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read runtime config: %w", err)
	}
	var cfg TemplateConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("decode runtime config: %w", err)
	}
	return BuildTemplateAdapters(cfg)
}

func BuildTemplateAdapters(cfg TemplateConfig) ([]Adapter, error) {
	seen := map[string]struct{}{}
	out := make([]Adapter, 0, len(cfg.Runtimes))
	for i, def := range cfg.Runtimes {
		adapter, err := NewTemplateAdapter(def)
		if err != nil {
			return nil, fmt.Errorf("runtime[%d]: %w", i, err)
		}
		if _, ok := seen[adapter.Name()]; ok {
			return nil, fmt.Errorf("runtime[%d]: duplicate runtime name %q", i, adapter.Name())
		}
		seen[adapter.Name()] = struct{}{}
		out = append(out, adapter)
	}
	return out, nil
}

func normalizeTemplateDefinition(def TemplateRuntimeDefinition) (TemplateRuntimeDefinition, error) {
	out := def
	out.Name = strings.TrimSpace(out.Name)
	out.Program = strings.TrimSpace(out.Program)
	out.ProbeProgram = strings.TrimSpace(out.ProbeProgram)
	if out.Name == "" {
		return TemplateRuntimeDefinition{}, fmt.Errorf("name is required")
	}
	if out.Program == "" {
		return TemplateRuntimeDefinition{}, fmt.Errorf("program is required")
	}
	if len(out.RunArgs) == 0 {
		return TemplateRuntimeDefinition{}, fmt.Errorf("run_args is required")
	}
	if out.Capabilities == (model.RuntimeCapabilities{}) {
		out.Capabilities = model.RuntimeCapabilities{
			SupportsNonInteractiveExec: true,
		}
	}
	return out, nil
}

func renderTemplateArgs(templates []string, req RunRequest, appendExtraArgs bool) ([]string, error) {
	prompt := req.Prompt
	workdir := strings.TrimSpace(req.Workdir)
	sawExtraArgsPlaceholder := false
	out := make([]string, 0, len(templates)+len(req.ExtraArgs))

	for _, tpl := range templates {
		switch tpl {
		case placeholderPrompt:
			out = append(out, prompt)
			continue
		case placeholderWorkdir:
			if workdir == "" {
				return nil, fmt.Errorf("workdir is required by runtime template")
			}
			out = append(out, workdir)
			continue
		case placeholderExtraArgs:
			sawExtraArgsPlaceholder = true
			out = append(out, req.ExtraArgs...)
			continue
		}

		if strings.Contains(tpl, placeholderExtraArgs) {
			return nil, fmt.Errorf("%s placeholder must be a standalone arg", placeholderExtraArgs)
		}
		arg := tpl
		if strings.Contains(arg, placeholderPrompt) {
			arg = strings.ReplaceAll(arg, placeholderPrompt, prompt)
		}
		if strings.Contains(arg, placeholderWorkdir) {
			if workdir == "" {
				return nil, fmt.Errorf("workdir is required by runtime template")
			}
			arg = strings.ReplaceAll(arg, placeholderWorkdir, workdir)
		}
		if strings.Contains(arg, "{{") || strings.Contains(arg, "}}") {
			return nil, fmt.Errorf("unsupported placeholder token in %q", tpl)
		}
		out = append(out, arg)
	}

	if appendExtraArgs && !sawExtraArgsPlaceholder {
		out = append(out, req.ExtraArgs...)
	}
	return out, nil
}
