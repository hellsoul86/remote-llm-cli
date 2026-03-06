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
8. [ISSUE-009 #17](https://github.com/hellsoul86/remote-llm-cli/issues/17): TUI jobs pane and multi-job watch controls.
9. [ISSUE-010 #18](https://github.com/hellsoul86/remote-llm-cli/issues/18): Async sync jobs and unified multi-type scheduler.
10. [ISSUE-011 #19](https://github.com/hellsoul86/remote-llm-cli/issues/19): Job cancellation API and cooperative timeout control.
11. [ISSUE-012 #20](https://github.com/hellsoul86/remote-llm-cli/issues/20): Codex session lifecycle management and resume UX.
12. [ISSUE-013 #21](https://github.com/hellsoul86/remote-llm-cli/issues/21): SSH transport hardening for production remote control.
13. [ISSUE-014 #22](https://github.com/hellsoul86/remote-llm-cli/issues/22): Observability, retention, and operational runbook.
14. [ISSUE-015 #23](https://github.com/hellsoul86/remote-llm-cli/issues/23): CI/e2e coverage for async job control plane.
15. [ISSUE-016 #24](https://github.com/hellsoul86/remote-llm-cli/issues/24): Runtime adapter contract v2 and next adapters.

## Planned PR Sequence

1. PR-001 -> ISSUE-001 (foundation vertical slice)
2. PR-002 -> ISSUE-002 (fanout and summary table)
3. PR-003 -> ISSUE-003 (audit storage + query endpoint + web + TUI history panes)
4. PR-004 -> ISSUE-004 #5 (runtime adapter extension points)
5. PR-005 -> ISSUE-005 #7 (codex deep runtime support)
6. PR-006 -> ISSUE-007 #12 (sync + retry + shell attach)
7. PR-007 -> ISSUE-008 #15 (async run jobs + polling/reconnect)
8. PR-008 -> ISSUE-009 #17 (TUI jobs pane + multi-job watch)
9. PR-009 -> ISSUE-010 #18 (async sync jobs + unified scheduler)
10. PR-010 -> ISSUE-011 #19 (job cancellation + cooperative cancel UX)
11. PR-011 -> ISSUE-012 #20 (codex session discover/cleanup + resume helpers)
12. PR-012 -> ISSUE-013 #21 (ssh hardening + preflight + classified errors)
13. PR-013 -> ISSUE-014 #22 (filters + retention + metrics + runbook)
14. PR-014 -> ISSUE-015 #23 (integration/e2e CI coverage)
15. PR-015 -> ISSUE-016 #24 (adapter contract v2 + next runtime adapter)

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

## Native Parity Wave (2026-03)

Epic:

- [#137](https://github.com/hellsoul86/remote-llm-cli/issues/137) codex native UX parity v1

Issue queue:

1. [#138](https://github.com/hellsoul86/remote-llm-cli/issues/138) session state contract: server truth + local cache boundaries
2. [#139](https://github.com/hellsoul86/remote-llm-cli/issues/139) stream pipeline: dedupe/order/reconnect/cursor resume
3. [#140](https://github.com/hellsoul86/remote-llm-cli/issues/140) timeline UX: content-only rendering + scroll pin behavior
4. [#141](https://github.com/hellsoul86/remote-llm-cli/issues/141) sidebar IA: server/project/session operations parity
5. [#142](https://github.com/hellsoul86/remote-llm-cli/issues/142) background sync: inactive session completion notifications
6. [#143](https://github.com/hellsoul86/remote-llm-cli/issues/143) composer parity: model discovery + permission/image controls
7. [#144](https://github.com/hellsoul86/remote-llm-cli/issues/144) session title lifecycle: derive/update/persist consistency
8. [#145](https://github.com/hellsoul86/remote-llm-cli/issues/145) parity e2e suite: mock/live scenario matrix
9. [#146](https://github.com/hellsoul86/remote-llm-cli/issues/146) release gate: staging soak checklist for native parity

Planned PR order:

1. PR-A -> #138
2. PR-B -> #139
3. PR-C -> #140
4. PR-D -> #141
5. PR-E -> #142
6. PR-F -> #143
7. PR-G -> #144
8. PR-H -> #145
9. PR-I -> #146

## Breaking Refactor Wave (Codex SDK + app-server Only)

Epic:

- [#168](https://github.com/hellsoul86/remote-llm-cli/issues/168) Breaking Refactor: Codex SDK + app-server mode only

Issue queue:

1. [#169](https://github.com/hellsoul86/remote-llm-cli/issues/169) Contract: strict codex session/turn API (job-decoupled)
2. [#170](https://github.com/hellsoul86/remote-llm-cli/issues/170) Web: codex session mode only (remove legacy jobs fallback)
3. [#171](https://github.com/hellsoul86/remote-llm-cli/issues/171) Server: codexrpc normalization + durable cursor stream
4. [#172](https://github.com/hellsoul86/remote-llm-cli/issues/172) Cutover: migration + CI gate for codex-only session architecture

Planned PR order:

1. PR-J -> #169
2. PR-K -> #170
3. PR-L -> #171
4. PR-M -> #172
