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

function readLiveAPIBase(): string {
  return (
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    ""
  );
}

function readLiveProjectPath(): string {
  return process.env.E2E_PROJECT_PATH?.trim() || "/home/ecs-user";
}

function requireLiveAPIBase(apiBase: string): void {
  test.skip(!apiBase, "E2E_API_BASE (or VITE_API_BASE) is required for live API assertions.");
}

function composerInput(page: Page): Locator {
  return page.locator(".composer textarea");
}

function sessionChip(page: Page, sessionID: string): Locator {
  return page.locator(`.session-chip-tree[data-session-id="${sessionID}"]`).first();
}

async function unlockSessionPage(page: Page, token: string): Promise<void> {
  await page.goto("/");
  const tokenInput = page.getByPlaceholder("rlm_xxx.yyy");
  if (await tokenInput.isVisible().catch(() => false)) {
    await tokenInput.fill(token);
    await page.getByRole("button", { name: "Unlock Workspace" }).click();
  }
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(
      async () => {
        return page.locator(".project-node").count();
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0);
  await expect(composerInput(page)).toBeVisible({ timeout: 120_000 });
}

async function selectStableProject(page: Page, projectPath: string): Promise<void> {
  const filter = page.getByPlaceholder("Filter projects or sessions");
  await filter.fill(projectPath);
  const projectNode = page.locator(".project-node", {
    has: page.locator(".project-chip-main em", { hasText: projectPath }),
  }).first();
  await expect(projectNode).toBeVisible({ timeout: 120_000 });
  const projectChip = projectNode.locator(".project-chip").first();
  await projectChip.scrollIntoViewIfNeeded();
  await projectChip.click();
  await expect(projectChip).toHaveClass(/active/, { timeout: 120_000 });
  await expect(page.locator(".chat-context")).toContainText(projectPath, {
    timeout: 120_000,
  });
  await filter.fill("");
}

async function createFreshSession(page: Page, projectPath: string): Promise<string> {
  await selectStableProject(page, projectPath);
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
  const activeSession = page.locator(".session-chip-tree.active").first();
  await expect(activeSession).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".chat-context")).toContainText(projectPath, {
    timeout: 120_000,
  });
  const sessionID = (await activeSession.getAttribute("data-session-id")) ?? "";
  expect(sessionID).not.toBe("");
  return sessionID;
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

async function waitForAssistantMessageWithMarker(page: Page, marker: string, timeout = 240_000): Promise<Locator> {
  const assistantMessages = page.locator(".message.message-assistant pre", { hasText: marker });
  await expect
    .poll(
      async () => assistantMessages.count(),
      { timeout },
    )
    .toBeGreaterThan(0);
  const latestAssistant = assistantMessages.last();
  await expect
    .poll(
      async () => {
        return ((await latestAssistant.textContent()) ?? "").trim();
      },
      { timeout },
    )
    .not.toBe("Thinking...");
  return latestAssistant;
}

async function archiveSessionViaUI(page: Page): Promise<void> {
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Archive session");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Archive", exact: true }).click();
}

async function archiveSessionViaAPI(
  page: Page,
  apiBase: string,
  token: string,
  sessionID: string,
): Promise<void> {
  const response = await page.request.post(
    `${apiBase}/v2/codex/sessions/${encodeURIComponent(sessionID)}/archive`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: {},
    },
  );
  const body = await response.json().catch(() => ({}));
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  expect(body?.archived).toBe(true);
}

async function unarchiveSessionViaAPI(
  page: Page,
  apiBase: string,
  token: string,
  sessionID: string,
): Promise<void> {
  const response = await page.request.post(
    `${apiBase}/v2/codex/sessions/${encodeURIComponent(sessionID)}/unarchive`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: {},
    },
  );
  const body = await response.json().catch(() => ({}));
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  expect(body?.session?.id ?? sessionID).toBe(sessionID);
}

test.describe.serial("live headless session flow (real API, no route mocking)", () => {
  test("desktop baseline: long reply + scroll pin + protocol hidden", async ({ page, baseURL }) => {
    const token = readLiveToken();
    const projectPath = readLiveProjectPath();
    requireLiveEnv(baseURL, token);

    await page.setViewportSize({ width: 1366, height: 900 });
    await unlockSessionPage(page, token);
    await createFreshSession(page, projectPath);

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
    const projectPath = readLiveProjectPath();
    requireLiveEnv(baseURL, token);

    await page.setViewportSize({ width: 1366, height: 900 });
    await unlockSessionPage(page, token);
    await createFreshSession(page, projectPath);

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

  test("refresh replay keeps a single assistant reply after reload", async ({ page, baseURL }) => {
    const token = readLiveToken();
    const apiBase = readLiveAPIBase();
    const projectPath = readLiveProjectPath();
    requireLiveEnv(baseURL, token);

    await page.setViewportSize({ width: 1366, height: 900 });
    await unlockSessionPage(page, token);
    const sessionID = await createFreshSession(page, projectPath);
    const marker = `LIVE_REPLAY_${Date.now()}`;

    try {
      await submitPrompt(
        page,
        `Reply with exactly one short sentence containing marker ${marker} exactly once.`,
      );
      await waitForAssistantMessageWithMarker(page, marker);
      await expect(
        page.locator(".message.message-assistant pre", { hasText: marker }),
      ).toHaveCount(1, { timeout: 240_000 });

      await page.reload();
      await unlockSessionPage(page, token);
      await expect(sessionChip(page, sessionID)).toBeVisible({ timeout: 120_000 });
      await sessionChip(page, sessionID).click();
      await expect(
        page.locator(".message.message-assistant pre", { hasText: marker }),
      ).toHaveCount(1, { timeout: 120_000 });
      await expect(page.locator(".session-alert")).toHaveCount(0);
      await expect(page.getByText(/^Done\.$/)).toHaveCount(0);
    } finally {
      if (apiBase) {
        await archiveSessionViaAPI(page, apiBase, token, sessionID).catch(() => {});
      }
    }
  });

  test("archive and unarchive restore a session across reload", async ({ page, baseURL }) => {
    const token = readLiveToken();
    const apiBase = readLiveAPIBase();
    const projectPath = readLiveProjectPath();
    requireLiveEnv(baseURL, token);
    requireLiveAPIBase(apiBase);

    await page.setViewportSize({ width: 1366, height: 900 });
    await unlockSessionPage(page, token);
    const sessionID = await createFreshSession(page, projectPath);
    const marker = `LIVE_ARCHIVE_${Date.now()}`;

    await submitPrompt(
      page,
      `Reply with exactly one short sentence containing marker ${marker} exactly once.`,
    );
    await waitForAssistantMessageWithMarker(page, marker);

    await archiveSessionViaUI(page);
    await expect(sessionChip(page, sessionID)).toHaveCount(0, { timeout: 120_000 });

    await unarchiveSessionViaAPI(page, apiBase, token, sessionID);
    await page.reload();
    await unlockSessionPage(page, token);
    await expect(sessionChip(page, sessionID)).toBeVisible({ timeout: 120_000 });
    await sessionChip(page, sessionID).click();
    await expect(
      page.locator(".message.message-assistant pre", { hasText: marker }),
    ).toHaveCount(1, { timeout: 120_000 });

    await archiveSessionViaAPI(page, apiBase, token, sessionID).catch(() => {});
  });
});

test.describe.serial("live headless mobile UX", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("mobile baseline: stacked layout + input behavior + send", async ({ page, baseURL }) => {
    const token = readLiveToken();
    const projectPath = readLiveProjectPath();
    requireLiveEnv(baseURL, token);

    await unlockSessionPage(page, token);
    await createFreshSession(page, projectPath);

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
