# Issue + PR Breakdown

This project follows an issue-first workflow. Every PR should map to one issue.

## Issue Queue

1. [ISSUE-001 #1](https://github.com/hellsoul86/remote-llm-cli/issues/1): Bootstrap `go + ts` monorepo and codex runtime foundation.
2. [ISSUE-002 #2](https://github.com/hellsoul86/remote-llm-cli/issues/2): Multi-host fanout run and summary.
3. [ISSUE-003 #3](https://github.com/hellsoul86/remote-llm-cli/issues/3): Audit/run history and terminal TUI mode.
4. ISSUE-004: Runtime adapter SDK for `claude`/`gemini` follow-up.

## Planned PR Sequence

1. PR-001 -> ISSUE-001 (foundation vertical slice)
2. PR-002 -> ISSUE-002 (fanout and summary table)
3. PR-003 -> ISSUE-003 (audit storage + query endpoint + web + TUI history panes)
4. PR-004 -> ISSUE-004 (runtime adapter extension points)

## Status

- PR-001/PR-002/PR-003: implemented in `feat/issue-1-2-3-mvp-controller` and pending review/merge.

## Branch Naming

- `feat/issue-xxx-short-title`
- `fix/issue-xxx-short-title`

## Commit Convention

- `feat(issue-xxx): ...`
- `fix(issue-xxx): ...`
- `chore(issue-xxx): ...`
