# Testing Guide

## Fast local subset (recommended before push)

1. Server unit/integration tests:

```bash
cd server
go test ./...
```

2. Web type/build check:

```bash
make protocol-schema-validate
cd web
npm run build
```

3. Web async control-plane smoke (Playwright):

```bash
cd web
npm run test:e2e:smoke
```

This now covers:
- pinned Codex app-server schema surface validation
- async session/job behavior (mocked API)
- session UX baseline (desktop/mobile layout + key interaction behavior)

4. Web live headless e2e against deployed environment (no API mocking):

```bash
cd web
E2E_BASE_URL="https://webcli-staging.royding.ai" \
E2E_ACCESS_TOKEN="rlm_xxx.yyy" \
npm run test:e2e:live
```

## CI checks

All PRs run:

1. `Server Test`
2. `Web Build`
3. `Web E2E Smoke`
4. `Target Branch Rules`
5. `PR Contract`

Protected branches (`staging`, `main`) must require at least:

1. `Server Test`
2. `Web Build`
3. `Web E2E Smoke`
4. `Target Branch Rules`
5. `PR Contract`

Post-merge push to `staging`/`main` runs deployment workflow (`Deploy`) when environment deploy config is present.

## Notes

- E2E smoke uses route-mocked API responses and validates async job submission/polling UX.
- Additional UX-focused smoke is in `web/e2e/session-ux.spec.ts`.
- Live e2e requires a real access token and does not intercept network requests.
- Regenerate pinned app-server fixtures with `make protocol-schema-sync`.
- If Playwright browsers are missing locally, install with:

```bash
cd web
npx playwright install chromium
```
