# Testing Guide

## Fast local subset (recommended before push)

1. Server unit/integration tests:

```bash
cd server
go test ./...
```

2. Web type/build check:

```bash
cd web
npm run build
```

3. Web async control-plane smoke (Playwright):

```bash
cd web
npm run test:e2e:smoke
```

## CI checks

PRs to `staging`/`main` run:

1. `Server Test`
2. `Web Build`
3. `Web E2E Smoke`
4. `Target Branch Rules`

## Notes

- E2E smoke uses route-mocked API responses and validates async job submission/polling UX.
- If Playwright browsers are missing locally, install with:

```bash
cd web
npx playwright install chromium
```
