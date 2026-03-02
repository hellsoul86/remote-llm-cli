# Adapter Authoring Guide (Contract v2)

This guide describes how to add a new runtime adapter to `remote-llm-cli`.

## 1. Implement adapter interface

In `server/internal/runtime`, implement:

1. `Name() string`
2. `Capabilities() model.RuntimeCapabilities`
3. `BuildProbeCommand() CommandSpec`
4. `BuildRunCommand(req RunRequest) (CommandSpec, error)`

For contract v2 metadata, also implement:

5. `Contract() model.RuntimeContract`

## 2. Contract v2 fields

- `version`: use `"v2"`
- `prompt_required`: `true` when empty prompt must fail validation
- `supports_workdir`: whether workdir override is supported by controller path
- `supports_extra_args`: whether adapter appends/passes `extra_args`

These fields are exposed via `GET /v1/runtimes`.

## 3. Registration

Register adapter in server bootstrap:

- `server/cmd/remote-llm-server/main.go`

Example:

```go
rt := runtime.NewRegistry(
    runtime.NewCodexAdapter(),
    runtime.NewClaudeCodeAdapter(),
    runtime.NewYourAdapter(),
)
```

## 4. Conformance tests

Add/extend tests under `server/internal/runtime/`:

- adapter-specific tests (command shape + validation)
- `conformance_test.go` fixtures to ensure:
  - v2 contract metadata exists
  - probe/run command are non-empty
  - prompt-required behavior is enforced where applicable

Run:

```bash
cd server
go test ./internal/runtime -v
```

## 5. Optional template path

If you do not need custom Go logic, use template adapter config (`examples/runtimes.example.json`) and ensure placeholders satisfy your runtime CLI contract.
