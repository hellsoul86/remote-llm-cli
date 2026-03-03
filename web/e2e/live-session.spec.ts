import { expect, test } from "@playwright/test";

function readLiveToken(): string {
  return (
    process.env.E2E_ACCESS_TOKEN?.trim() ||
    process.env.PLAYWRIGHT_E2E_ACCESS_TOKEN?.trim() ||
    process.env.ACCESS_TOKEN?.trim() ||
    ""
  );
}

test("live headless session flow (real API, no route mocking)", async ({ page, baseURL }) => {
  const configuredBaseURL = (process.env.E2E_BASE_URL ?? "").trim();
  const token = readLiveToken();

  test.skip(!configuredBaseURL, "E2E_BASE_URL is required for live e2e.");
  test.skip(!token, "E2E_ACCESS_TOKEN (or PLAYWRIGHT_E2E_ACCESS_TOKEN) is required for live e2e.");
  test.skip(!baseURL, "Playwright baseURL is not configured.");

  const marker = `PW_LIVE_${Date.now()}`;
  await page.goto("/");

  const tokenInput = page.getByPlaceholder("rlm_xxx.yyy");
  if (await tokenInput.isVisible().catch(() => false)) {
    await tokenInput.fill(token);
    await page.getByRole("button", { name: "Unlock Workspace" }).click();
  }

  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 120_000 });
  const composer = page.getByPlaceholder("Tell codex what to do in this workspace...");
  await expect(composer).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 120_000 });

  await composer.fill("line-a");
  await composer.press("Shift+Enter");
  await composer.type("line-b");
  await expect(composer).toHaveValue("line-a\nline-b");

  const assistantMessages = page.locator(".message.message-assistant pre");
  const beforeAssistantCount = await assistantMessages.count();

  await composer.fill(`Reply in one concise sentence and include this marker exactly once: ${marker}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");

  await expect.poll(async () => assistantMessages.count(), { timeout: 240_000 }).toBeGreaterThan(beforeAssistantCount);
  const newestAssistant = assistantMessages.last();
  await expect(newestAssistant).toContainText(marker, { timeout: 240_000 });

  const newestText = ((await newestAssistant.textContent()) ?? "").trim();
  expect(newestText).not.toBe("Done.");
  await expect(page.locator(".message.message-assistant pre", { hasText: marker })).toHaveCount(1);
  await expect(page.getByText(/"type":"thread.started"/)).toHaveCount(0);
  await expect.poll(async () => page.locator(".session-chip-tree").count(), { timeout: 60_000 }).toBeGreaterThan(0);
});

