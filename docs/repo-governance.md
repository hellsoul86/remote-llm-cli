# Repo Governance

## Branches

Long-lived branches:

- `main`: production-ready branch
- `staging`: integration and pre-release validation branch

Short-lived branches:

- `feat/issue-xxx-...`
- `fix/issue-xxx-...`
- `chore/issue-xxx-...`
- `hotfix/issue-xxx-...`

## PR target rules

- Feature/fix/chore PRs target `staging`
- Release PR targets `main` from `staging`
- Emergency hotfix PRs can target `main` from `hotfix/*`
- Hotfix changes must be back-merged/cherry-picked to `staging` after `main` merge

## Merge strategy

- Feature/fix/chore into `staging`: `squash merge`
- `staging` into `main` release PR: `merge commit`
- Hotfix into `main`: `merge commit` preferred for audit clarity

## CI policy

Required checks for PRs to `staging`/`main`:

- `Server Test` (Go test)
- `Web Build` (TypeScript + Vite build)
- `Web E2E Smoke` (Playwright async-job UI smoke)
- `Target Branch Rules` (PR target governance)

Workflows:

- `.github/workflows/ci.yml`
- `.github/workflows/pr-governance.yml`
- `.github/workflows/deploy.yml` (post-merge deploy on `staging`/`main`)

## Current merge order (active stacked PRs)

1. `#4` `feat/issue-1-2-3-mvp-controller` -> `staging`
2. `#6` `feat/issue-5-runtime-adapter-sdk` -> `feat/issue-1-2-3-mvp-controller`
3. `#8` `feat/issue-7-codex-runtime-deepening` -> `feat/issue-5-runtime-adapter-sdk`
4. `#10` `feat/issue-9-branch-governance` -> `feat/issue-7-codex-runtime-deepening`

After `#4/#6/#8/#10` are merged sequentially, open release PR:

- `staging` -> `main`
