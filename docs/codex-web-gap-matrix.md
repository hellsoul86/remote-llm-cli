# Codex Web Gap Matrix

Scope date: 2026-03-07 (Asia/Shanghai)
Baseline sources:

- `docs/codex-macos-feature-inventory.md`
- official Codex app docs and screenshots

Legend:

- `Keep`: existing behavior mostly matches the target and should be preserved
- `Redesign`: capability exists but the IA or interaction is off-target
- `Add`: capability is materially missing
- `Defer`: not a first-wave implementation blocker, but the IA slot must be designed now

| Surface | Official target | Current WebCLI | Decision |
| --- | --- | --- | --- |
| Global shell | One calm workbench with secondary surfaces | `Session/Ops` split still defines the app shell | Redesign |
| Host visibility | Host is secondary metadata, not primary navigation | Host is a permanent top-level tree grouping | Redesign |
| Projects list | Compact project navigator | CRUD-heavy project rail | Redesign |
| Threads list | Thread-first navigation with unread/running cues | Session chips exist, but nested too deep under host/project tree | Redesign |
| Project creation | Sheet/modal or lightweight picker | Inline form in the sidebar | Redesign |
| Thread title lifecycle | Auto updates and stable persistence | Implemented via title update events | Keep |
| Background completion | Quiet unread + notification once | Mostly implemented, but UX still noisy in places | Redesign |
| Timeline content | Content-first, no transport noise | Core dedupe/noise cleanup exists | Keep |
| Timeline status rendering | Minimal thread status, no job/runtime cards | Still has some runtime-centric affordances in the workbench | Redesign |
| Header | Minimal thread/project/worktree context | Still exposes stream/reconnect/archive too prominently | Redesign |
| Composer shell | Single primary input surface | Still feels like a settings console | Redesign |
| Model selector | Compact and contextual | Implemented, but styled as form control | Redesign |
| Sandbox / permission | Compact and contextual | Implemented, but too exposed and form-like | Redesign |
| Image attach | First-class attachment flow | Implemented | Keep |
| Slash commands | Native command affordance in composer | Partially implied, not properly surfaced in UI | Add |
| Skill entry | `$skill` style secondary surface | No real native skill surface | Add |
| Review pane | Dedicated diff/review side pane | Review mode exists in payloads, not as native UI | Add |
| Terminal drawer | Dedicated bottom terminal | Not present as native drawer | Add |
| Worktree bar | Local/worktree/cloud context in header | Missing | Add |
| Local environment actions | Open/run/handoff action cluster | Missing | Add |
| Command palette | Global command menu | Implemented | Keep |
| Core shortcuts | Sidebar, terminal, diff, new thread, find | Partial | Redesign |
| Archived threads | Hidden from main list, discoverable via filter/search | Archive exists, but main-list behavior is not native | Redesign |
| Settings | Separate settings surface | Utility panels are still too embedded | Defer |
| Skills browser | Secondary surface | Missing | Defer |
| Automations | Separate page/surface | Missing | Defer |
| Cloud mode | Capability-driven mode tab | Missing as a native workbench mode | Defer |
| Pop-out / stay-on-top | Secondary enhancement | Missing | Defer |
| Visual regression gate | Screenshot and layout baseline | No real visual parity gate | Add |
| Live parity gate | Real staging workbench flow vs official baseline | Partial live smoke only | Add |

## Immediate Implementation Focus

This wave should only claim parity progress if it lands the following together:

- shell reduction
- host de-emphasis
- project/thread navigator redesign
- composer redesign
- review pane architecture and visible surface
- terminal drawer architecture and visible surface
- visual regression acceptance

If a change improves a capability but makes the shell feel more like an admin console, it fails the parity bar.
