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

Repository setting:

- `delete_branch_on_merge = false`
  - stacked child PRs must keep their base branch alive until the next PR is retargeted

## PR target rules

- Feature/fix/chore PRs target `staging`
- Release PR targets `main` from `staging`
- Emergency hotfix PRs can target `main` from `hotfix/*`
- Hotfix changes must be back-merged/cherry-picked to `staging` after `main` merge

## PR contract

Every PR must include:

- `Summary`
- `Linked Issue`
- `Changes`
- `DB Change`
- `Migration Plan` when DB impact is not `none`
- `Rollback Plan`
- `Verification`
- `Risk`

The workflow `.github/workflows/pr-governance.yml` enforces this contract on every PR, including stacked child PRs.

## Stacked PR operating mode

Stacked PRs are allowed for large epics, but they are review slices, not release branches.

Rules:

- all PRs run CI, even when the base is another feature branch
- only one PR at a time should be pointed at `staging` for merge
- after a parent PR merges to `staging`, retarget its direct child to `staging`, update branch, wait for green, then merge
- do not delete intermediate stack branches until their child PR has been retargeted

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
- `PR Contract` (issue link, verification, rollback, DB declaration)

Workflows:

- `.github/workflows/ci.yml`
- `.github/workflows/pr-governance.yml`
- `.github/workflows/deploy.yml` (post-merge deploy on `staging`/`main`)
- `.github/workflows/staging-live-e2e.yml` (manual live parity evidence on staging)

Branch protection on GitHub must match the exact required check names above.

## Deploy gate

- only pushes to protected branches (`staging`, `main`) trigger deployment
- deploy must complete post-deploy smoke before the run is considered healthy
- native parity signoff on `staging` also requires the manual `Staging Live E2E` workflow when issues call for real session-flow evidence
- staging soak remains a manual longer-running validation, not a merge blocker
