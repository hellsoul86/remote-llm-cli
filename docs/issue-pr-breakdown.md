# Issue + PR Breakdown

This project follows an issue-first workflow. Every PR should map to one issue.

## Issue Queue

1. [ISSUE-001 #1](https://github.com/hellsoul86/remote-llm-cli/issues/1): Bootstrap `go + ts` monorepo and codex runtime foundation.
2. [ISSUE-002 #2](https://github.com/hellsoul86/remote-llm-cli/issues/2): Multi-host fanout run and summary.
3. [ISSUE-003 #3](https://github.com/hellsoul86/remote-llm-cli/issues/3): Audit/run history and terminal TUI mode.
4. [ISSUE-004 #5](https://github.com/hellsoul86/remote-llm-cli/issues/5): Runtime adapter SDK for `claude`/`gemini` follow-up.
5. [ISSUE-005 #7](https://github.com/hellsoul86/remote-llm-cli/issues/7): Codex runtime deepening.
6. [ISSUE-007 #12](https://github.com/hellsoul86/remote-llm-cli/issues/12): Deep remote operations (`sync`, retry policy, shell attach).
7. [ISSUE-008 #15](https://github.com/hellsoul86/remote-llm-cli/issues/15): Async run jobs and reconnectable status polling.

## Planned PR Sequence

1. PR-001 -> ISSUE-001 (foundation vertical slice)
2. PR-002 -> ISSUE-002 (fanout and summary table)
3. PR-003 -> ISSUE-003 (audit storage + query endpoint + web + TUI history panes)
4. PR-004 -> ISSUE-004 #5 (runtime adapter extension points)
5. PR-005 -> ISSUE-005 #7 (codex deep runtime support)
6. PR-006 -> ISSUE-007 #12 (sync + retry + shell attach)
7. PR-007 -> ISSUE-008 #15 (async run jobs + polling/reconnect)

## Branch Targets

- `feat/*`, `fix/*`, `chore/*` -> `staging`
- release PR: `staging` -> `main`
- `hotfix/*` -> `main` (then back-merge to `staging`)

## Status

- PR-001/PR-002/PR-003: implemented in `feat/issue-1-2-3-mvp-controller` and pending review/merge.
- PR-004: in progress on `feat/issue-5-runtime-adapter-sdk`.
- PR-005: in progress on `feat/issue-7-codex-runtime-deepening`.

Current merge order:

1. [PR #4](https://github.com/hellsoul86/remote-llm-cli/pull/4) `feat/issue-1-2-3-mvp-controller` -> `staging`
2. [PR #6](https://github.com/hellsoul86/remote-llm-cli/pull/6) `feat/issue-5-runtime-adapter-sdk` -> `feat/issue-1-2-3-mvp-controller`
3. [PR #8](https://github.com/hellsoul86/remote-llm-cli/pull/8) `feat/issue-7-codex-runtime-deepening` -> `feat/issue-5-runtime-adapter-sdk`
4. [PR #10](https://github.com/hellsoul86/remote-llm-cli/pull/10) `feat/issue-9-branch-governance` -> `feat/issue-7-codex-runtime-deepening`
5. release PR: `staging` -> `main`

## Branch Naming

- `feat/issue-xxx-short-title`
- `fix/issue-xxx-short-title`

## Commit Convention

- `feat(issue-xxx): ...`
- `fix(issue-xxx): ...`
- `chore(issue-xxx): ...`
