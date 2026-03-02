package runtime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTemplateAdapterBuildRunCommand(t *testing.T) {
	adapter, err := NewTemplateAdapter(TemplateRuntimeDefinition{
		Name:      "testcli",
		Program:   "testcli",
		RunArgs:   []string{"run", "--prompt", "{{prompt}}", "{{extra_args}}"},
		ProbeArgs: []string{"--version"},
	})
	if err != nil {
		t.Fatalf("new template adapter: %v", err)
	}

	spec, err := adapter.BuildRunCommand(RunRequest{
		Prompt:    "hello",
		ExtraArgs: []string{"--json", "--dry-run"},
	})
	if err != nil {
		t.Fatalf("build run command: %v", err)
	}
	if spec.Program != "testcli" {
		t.Fatalf("program=%q want=testcli", spec.Program)
	}
	if len(spec.Args) != 5 {
		t.Fatalf("args len=%d want=5", len(spec.Args))
	}
	if spec.Args[0] != "run" || spec.Args[1] != "--prompt" || spec.Args[2] != "hello" {
		t.Fatalf("unexpected args prefix: %v", spec.Args)
	}
	if spec.Args[3] != "--json" || spec.Args[4] != "--dry-run" {
		t.Fatalf("unexpected extra args: %v", spec.Args)
	}
}

func TestTemplateAdapterWorkdirPlaceholder(t *testing.T) {
	adapter, err := NewTemplateAdapter(TemplateRuntimeDefinition{
		Name:    "wdcli",
		Program: "wdcli",
		RunArgs: []string{"run", "--cwd", "{{workdir}}", "{{prompt}}"},
	})
	if err != nil {
		t.Fatalf("new template adapter: %v", err)
	}
	if _, err := adapter.BuildRunCommand(RunRequest{Prompt: "hello"}); err == nil {
		t.Fatalf("expected error when workdir placeholder exists but request has empty workdir")
	}
	spec, err := adapter.BuildRunCommand(RunRequest{
		Prompt:  "hello",
		Workdir: "/tmp/project",
	})
	if err != nil {
		t.Fatalf("build run command: %v", err)
	}
	if len(spec.Args) != 4 || spec.Args[2] != "/tmp/project" {
		t.Fatalf("unexpected args: %v", spec.Args)
	}
}

func TestLoadTemplateAdaptersFromFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtimes.json")
	content := `{
  "runtimes": [
    {
      "name": "claudecode",
      "program": "claude",
      "run_args": ["exec", "{{prompt}}", "{{extra_args}}"],
      "probe_args": ["--version"]
    },
    {
      "name": "geminicli",
      "program": "gemini",
      "run_args": ["run", "--prompt", "{{prompt}}"]
    }
  ]
}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	adapters, err := LoadTemplateAdaptersFromFile(path)
	if err != nil {
		t.Fatalf("load adapters: %v", err)
	}
	if len(adapters) != 2 {
		t.Fatalf("len(adapters)=%d want=2", len(adapters))
	}
	if adapters[0].Name() != "claudecode" || adapters[1].Name() != "geminicli" {
		t.Fatalf("unexpected adapters: %s %s", adapters[0].Name(), adapters[1].Name())
	}
}

func TestLoadTemplateAdaptersDuplicateName(t *testing.T) {
	_, err := BuildTemplateAdapters(TemplateConfig{
		Runtimes: []TemplateRuntimeDefinition{
			{Name: "same", Program: "a", RunArgs: []string{"{{prompt}}"}},
			{Name: "same", Program: "b", RunArgs: []string{"{{prompt}}"}},
		},
	})
	if err == nil {
		t.Fatalf("expected duplicate name error")
	}
}
