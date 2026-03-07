# Codex App Parity Roadmap (WebCLI)

## Goal

Align WebCLI with the native Codex app interaction model first, while treating CLI option coverage as secondary support work.

Execution tracking:

- Feature inventory: `docs/codex-macos-feature-inventory.md`
- Gap matrix: `docs/codex-web-gap-matrix.md`
- UX contract: `docs/codex-native-ux-contract-v3.md`
- Epic: #137
- Reset/design issue: #192
- Implementation issue: #200

This document defines:

- what the native Codex experience should feel like,
- which official app surfaces are first-wave blockers,
- where current WebCLI still deviates,
- the phased order to close those gaps.

## Baseline

Reference binary on staging controller host:

- `codex-cli 0.107.0`

Reference app baseline:

- official Codex app docs and screenshots
- official app-server protocol and tests

## First-wave Blocking Scope

The first parity wave is not session-only anymore. It must land these together:

- workbench-first shell
- project/thread navigator that weakens host prominence
- content-first conversation workbench
- composer redesign
- review pane
- terminal drawer
- background completion fidelity
- visual and live parity gates

The following must be fully designed now but are not first-wave implementation blockers:

- settings
- skills browser and remote skills flows
- automations
- cloud mode
- pop-out windows / stay-on-top

## Capability Matrix

Legend:

- `Keep`
- `Redesign`
- `Add`
- `Defer`

| Area | Decision | Notes |
| --- | --- | --- |
| Global shell | Redesign | Remove dashboard split and make workbench primary |
| Host visibility | Redesign | Host becomes secondary context |
| Project/thread navigator | Redesign | Compact, native-feeling left rail |
| Timeline core | Keep | Deduped content rendering remains useful |
| Header | Redesign | Remove transport emphasis |
| Composer | Redesign | Input-first shell with compact controls |
| Image attach | Keep | Preserve existing attach path |
| Command palette | Keep | Keep as a core native affordance |
| Review pane | Add | Native diff/review surface |
| Terminal drawer | Add | Native bottom-docked terminal |
| Worktree bar | Add | Context bar for project/worktree actions |
| Settings/skills/automations/cloud | Defer | Design now, implement later |
| Visual regression | Add | Screenshot-level acceptance |
| Live parity gate | Add | Real staging flows against native contract |

## Implementation Phases

### Phase P0: Documentation Baseline

- feature inventory
- gap matrix
- native UX contract v3

### Phase P1: Shell Reduction

- demote utilities out of the primary shell
- remove controller-first chrome from the default path
- make workbench visually dominant

### Phase P2: Navigator Parity

- flatten project-first navigation
- weaken host prominence
- move create/rename/archive into lighter surfaces

### Phase P3: Workbench Parity

- simplify header
- keep timeline content-first
- redesign composer so model/permission/image stay compact and contextual

### Phase P4: Review + Terminal

- add a real review pane
- add a real terminal drawer
- connect both to thread/project context rather than chat noise

### Phase P5: Parity Gates

- visual regression snapshots
- live staging workbench flows
- soak signoff against the v3 contract

## UX Rules For Parity Work

- no `job` or transport mental model in the default thread path
- utilities must be secondary surfaces
- unsupported capabilities must be hidden, not teased as dead controls
- a feature is not considered parity-complete if it makes the app feel more like an admin console than a native Codex workbench
