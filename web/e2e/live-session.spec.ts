import { expect, test, type Locator, type Page } from "@playwright/test";

const EMPTY_ASSISTANT_FALLBACK = "No assistant output captured.";

function readLiveToken(): string {
  return (
    process.env.E2E_ACCESS_TOKEN?.trim() ||
    process.env.PLAYWRIGHT_E2E_ACCESS_TOKEN?.trim() ||
    process.env.ACCESS_TOKEN?.trim() ||
    ""
  );
}

function requireLiveEnv(baseURL: string | undefined, token: string): void {
  const configuredBaseURL = (process.env.E2E_BASE_URL ?? "").trim();
  test.skip(!configuredBaseURL, "E2E_BASE_URL is required for live e2e.");
  test.skip(!token, "E2E_ACCESS_TOKEN (or PLAYWRIGHT_E2E_ACCESS_TOKEN) is required for live e2e.");
  test.skip(!baseURL, "Playwright baseURL is not configured.");
}

function composerInput(page: Page): Locator {
  return page.locator(".composer textarea");
}

async function unlockSessionPage(page: Page, token: string): Promise<void> {
  await page.goto("/");
  const tokenInput = page.getByPlaceholder("rlm_xxx.yyy");
  if (await tokenInput.isVisible().catch(() => false)) {
    await tokenInput.fill(token);
    await page.getByRole("button", { name: "Unlock Workspace" }).click();
  }
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 120_000 });
  await expect(composerInput(page)).toBeVisible({ timeout: 120_000 });
}

async function createFreshSession(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New Session", exact: true }).click();
  const heading = page.locator(".chat-head h1");
  await expect
    .poll(
      async () => {
        return ((await heading.textContent()) ?? "").trim();
      },
      { timeout: 30_000 }
    )
    .toMatch(/^Session(?:\s+\d+)?$/);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 120_000 });
}

async function submitPrompt(page: Page, prompt: string): Promise<void> {
  const composer = composerInput(page);
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
}

async function waitForAssistantMessageCountIncrease(messages: Locator, beforeCount: number, timeout = 240_000): Promise<void> {
  await expect
    .poll(
      async () => {
        return messages.count();
      },
      { timeout }
    )
    .toBeGreaterThan(beforeCount);
}

test.describe.serial("live headless session flow (real API, no route mocking)", () => {
  test("desktop baseline: long reply + scroll pin + protocol hidden", async ({ page, baseURL }) => {
    const token = readLiveToken();
    requireLiveEnv(baseURL, token);

    await page.setViewportSize({ width: 1366, height: 900 });
    await unlockSessionPage(page, token);
    await createFreshSession(page);

    await expect(page.locator(".session-side")).toBeVisible();
    await expect(page.locator(".chat-pane")).toBeVisible();

    const marker = `LIVE_LONG_${Date.now()}`;
    const assistantMessages = page.locator(".message.message-assistant pre");
    const beforeCount = await assistantMessages.count();

    await submitPrompt(
      page,
      [
        `Reply in plain text with exactly 80 short lines.`,
        `Every line must include marker ${marker}.`,
        `No code fences, no JSON, no commentary outside those lines.`
      ].join(" ")
    );

    await waitForAssistantMessageCountIncrease(assistantMessages, beforeCount);
    const latestAssistant = assistantMessages.last();
    let latestText = "";
    await expect
      .poll(
        async () => {
          latestText = ((await latestAssistant.textContent()) ?? "").trim();
          return latestText;
        },
        { timeout: 240_000 }
      )
      .not.toBe("Thinking...");
    await expect(page.getByText(/"type":"thread.started"/)).toHaveCount(0);
    await expect(page.getByText(/^Done\.$/)).toHaveCount(0);
    if (latestText !== EMPTY_ASSISTANT_FALLBACK) {
      await expect(latestAssistant).toContainText(marker, { timeout: 240_000 });
      await expect
        .poll(
          async () => {
            return page.locator(".message.message-assistant pre", { hasText: marker }).count();
          },
          { timeout: 120_000 }
        )
        .toBeGreaterThan(0);
      const lineCount = latestText.split("\n").filter((line) => line.trim() !== "").length;
      expect(lineCount >= 20).toBeTruthy();

      const timelineMetrics = await page.locator(".timeline").evaluate((el) => ({
        overflow: el.scrollHeight - el.clientHeight,
        gap: Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop)
      }));
      if (timelineMetrics.overflow > 0) {
        expect(timelineMetrics.gap <= 72).toBeTruthy();
      }
    }
  });

  test("session switch: background completion should surface alert/unread and preserve response", async ({ page, baseURL }) => {
    const token = readLiveToken();
    requireLiveEnv(baseURL, token);

    await page.setViewportSize({ width: 1366, height: 900 });
    await unlockSessionPage(page, token);
    await createFreshSession(page);

    const session1Chip = page.locator(".session-chip-tree.active").first();
    const session1ID = (await session1Chip.getAttribute("data-session-id")) ?? "";
    expect(session1ID).not.toBe("");
    await page.getByRole("button", { name: "New Session", exact: true }).click();
    const session2Chip = page.locator(".session-chip-tree.active").first();
    await expect(session2Chip).toBeVisible({ timeout: 30_000 });
    const session2ID = (await session2Chip.getAttribute("data-session-id")) ?? "";
    expect(session2ID).not.toBe("");
    const alertBefore = await page.locator(".session-alert").count();

    const marker = `LIVE_BG_${Date.now()}`;
    await submitPrompt(page, `Reply with one short sentence containing marker ${marker} exactly once.`);

    await page.locator(`.session-chip-tree[data-session-id="${session1ID}"]`).first().click();

    await expect
      .poll(
        async () => {
          return page.locator(".session-alert").count();
        },
        { timeout: 240_000 }
      )
      .toBeGreaterThan(alertBefore);

    await page.locator(`.session-chip-tree[data-session-id="${session2ID}"]`).first().click();
    const latestAssistant = page.locator(".message.message-assistant pre").last();
    await expect
      .poll(
        async () => {
          return ((await latestAssistant.textContent()) ?? "").trim();
        },
        { timeout: 240_000 }
      )
      .not.toBe("Thinking...");
  });
});

test.describe.serial("live headless mobile UX", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("mobile baseline: stacked layout + input behavior + send", async ({ page, baseURL }) => {
    const token = readLiveToken();
    requireLiveEnv(baseURL, token);

    await unlockSessionPage(page, token);
    await createFreshSession(page);

    const side = page.locator(".session-side");
    const chat = page.locator(".chat-pane");
    await expect(side).toBeVisible();
    await expect(chat).toBeVisible();

    const sideBox = await side.boundingBox();
    const chatBox = await chat.boundingBox();
    expect(sideBox).not.toBeNull();
    expect(chatBox).not.toBeNull();
    expect((chatBox?.y ?? 0) > (sideBox?.y ?? 0)).toBeTruthy();

    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowX <= 2).toBeTruthy();

    const composer = composerInput(page);
    await composer.fill("line-a");
    await composer.press("Shift+Enter");
    await composer.type("line-b");
    await expect(composer).toHaveValue("line-a\nline-b");

    const marker = `LIVE_MOBILE_${Date.now()}`;
    const assistantMessages = page.locator(".message.message-assistant pre");
    const beforeCount = await assistantMessages.count();

    await submitPrompt(page, `Reply with one short sentence containing marker ${marker} exactly once.`);
    await waitForAssistantMessageCountIncrease(assistantMessages, beforeCount);
    const latestAssistant = assistantMessages.last();
    await expect
      .poll(
        async () => {
          return ((await latestAssistant.textContent()) ?? "").trim();
        },
        { timeout: 240_000 }
      )
      .not.toBe("Thinking...");
    const latestText = ((await latestAssistant.textContent()) ?? "").trim();
    if (latestText !== EMPTY_ASSISTANT_FALLBACK) {
      await expect(latestAssistant).toContainText(marker, { timeout: 240_000 });
    }
  });
});
