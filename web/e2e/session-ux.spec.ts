import { expect, test, type Page } from "@playwright/test";

type MockHarness = {
  runRequests: () => number;
};

type MockOptions = {
  streamPattern?: "ready-only" | "completion-once";
  includeSecondSession?: boolean;
  backgroundCompletion?: boolean;
  titleUpdate?: string;
  jobRunningPolls?: number;
};

function buildLongAssistantReply(marker: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 80; i += 1) {
    lines.push(`line-${i.toString().padStart(2, "0")} ${marker}`);
  }
  return lines.join("\n");
}

async function mockSessionApi(
  page: Page,
  assistantReply: string,
  marker: string,
  options?: MockOptions,
): Promise<MockHarness> {
  let jobPollCount = 0;
  let eventPollCount = 0;
  let runReqCount = 0;
  const streamPattern = options?.streamPattern ?? "ready-only";
  const includeSecondSession = options?.includeSecondSession ?? false;
  const backgroundCompletion = options?.backgroundCompletion ?? false;
  const titleUpdate = options?.titleUpdate?.trim() ?? "";
  const jobRunningPolls = Math.max(1, options?.jobRunningPolls ?? 1);
  const nowISO = new Date().toISOString();
  const sessions = [
    {
      id: "session_cli_1",
      title: "Session 1",
      updated_at: nowISO,
      created_at: "2026-03-03T00:00:00Z",
    },
    ...(includeSecondSession
      ? [
          {
            id: "session_cli_2",
            title: "Session 2",
            updated_at: nowISO,
            created_at: "2026-03-03T00:00:00Z",
          },
        ]
      : []),
  ];

  await page.route("**/v1/healthz", async (route) => {
    await route.fulfill({
      status: 200,
      json: { ok: true, timestamp: "2026-03-03T00:00:00Z" },
    });
  });
  await page.route("**/v1/hosts", async (route, request) => {
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        hosts: [
          {
            id: "local_1",
            name: "local-default",
            connection_mode: "local",
            host: "localhost",
            user: "",
            port: 22,
            workspace: "/srv/work",
          },
        ],
      },
    });
  });
  await page.route("**/v1/runtimes", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        runtimes: [
          {
            name: "codex",
            capabilities: {
              supports_non_interactive_exec: true,
              supports_interactive_session: false,
              supports_structured_output: true,
              supports_file_patch_mode: false,
              supports_cost_metrics: false,
            },
          },
        ],
      },
    });
  });
  await page.route("**/v1/runs**", async (route) => {
    await route.fulfill({ status: 200, json: { runs: [] } });
  });
  await page.route("**/v1/audit**", async (route) => {
    await route.fulfill({ status: 200, json: { events: [] } });
  });
  await page.route("**/v1/metrics", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        jobs: {
          total: 1,
          pending: 0,
          running: 0,
          succeeded: 1,
          failed: 0,
          canceled: 0,
          retry_attempts: 0,
        },
        queue: {
          depth: 0,
          workers_total: 2,
          workers_active: 0,
          worker_utilization: 0,
        },
        success_rate: 1,
      },
    });
  });
  await page.route("**/v1/admin/retention", async (route, request) => {
    if (request.method() !== "GET" && request.method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        retention: {
          run_records_max: 500,
          run_jobs_max: 1000,
          audit_events_max: 5000,
        },
      },
    });
  });
  await page.route("**/v1/codex/models**", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        runtime: "codex",
        default_model: "gpt-5-codex",
        models: ["gpt-5-codex", "gpt-5"],
      },
    });
  });
  await page.route("**/v1/projects**", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        projects: [
          {
            id: "project_local_1__srv_work",
            host_id: "local_1",
            host_name: "local-default",
            path: "/srv/work",
            runtime: "codex",
            created_at: "2026-03-03T00:00:00Z",
            updated_at: "2026-03-03T00:00:00Z",
          },
        ],
      },
    });
  });
  await page.route("**/v1/sessions?**", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        sessions: sessions.map((sessionItem) => ({
          id: sessionItem.id,
          project_id: "project_local_1__srv_work",
          host_id: "local_1",
          path: "/srv/work",
          runtime: "codex",
          title: sessionItem.title,
          created_at: sessionItem.created_at,
          updated_at: sessionItem.updated_at,
        })),
      },
    });
  });
  await page.route("**/v1/sessions/session_cli_1/stream**", async (route) => {
    if (streamPattern === "completion-once") {
      const chunk =
        `{"type":"thread.started","thread_id":"t_ux"}\n` +
        `{"type":"turn.started"}\n` +
        `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: assistantReply } })}\n`;
      const events = [
        {
          seq: 1,
          type: "run.started",
          payload: { job_id: "job_ux_1" },
          createdAt: "2026-03-03T00:00:00Z",
        },
        {
          seq: 2,
          type: "assistant.delta",
          payload: { job_id: "job_ux_1", chunk },
          createdAt: "2026-03-03T00:00:00Z",
        },
        {
          seq: 3,
          type: "assistant.completed",
          payload: { job_id: "job_ux_1", run_id: "job_ux_1" },
          createdAt: "2026-03-03T00:00:01Z",
        },
      ];
      if (titleUpdate) {
        events.push({
          seq: events.length + 1,
          type: "session.title.updated",
          payload: { title: titleUpdate },
          createdAt: "2026-03-03T00:00:01Z",
        });
      }
      events.push({
        seq: events.length + 1,
        type: "run.completed",
        payload: { job_id: "job_ux_1" },
        createdAt: "2026-03-03T00:00:01Z",
      });
      const streamLines = [
        `event: session.ready`,
        `data: {"session_id":"session_cli_1","cursor":0}`,
        ``,
      ];
      for (const event of events) {
        streamLines.push(`event: session.event`);
        streamLines.push(
          `data: ${JSON.stringify({
            seq: event.seq,
            session_id: "session_cli_1",
            run_id: "job_ux_1",
            type: event.type,
            payload: event.payload,
            created_at: event.createdAt,
          })}`,
        );
        streamLines.push(``);
      }
      streamLines.push(``);
      const streamBody = streamLines.join("\n");
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: streamBody,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: `event: session.ready\ndata: {"session_id":"session_cli_1","cursor":0}\n\n`,
    });
  });
  await page.route("**/v1/sessions/session_cli_2/stream**", async (route) => {
    if (!includeSecondSession) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `event: session.ready\ndata: {"session_id":"session_cli_2","cursor":0}\n\n`,
      });
      return;
    }
    if (!backgroundCompletion) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `event: session.ready\ndata: {"session_id":"session_cli_2","cursor":0}\n\n`,
      });
      return;
    }
    const streamChunk =
      `{"type":"thread.started","thread_id":"t_bg"}\n` +
      `{"type":"turn.started"}\n` +
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `background reply ${marker}` } })}\n`;
    const startedAt = new Date(Date.now() - 1400).toISOString();
    const finishedAt = new Date().toISOString();
    const streamBody = [
      `event: session.ready`,
      `data: {"session_id":"session_cli_2","cursor":0}`,
      ``,
      `event: session.event`,
      `data: {"seq":1,"session_id":"session_cli_2","run_id":"job_bg_1","type":"run.started","payload":{"job_id":"job_bg_1"},"created_at":"${startedAt}"}`,
      ``,
      `event: session.event`,
      `data: {"seq":2,"session_id":"session_cli_2","run_id":"job_bg_1","type":"assistant.delta","payload":{"job_id":"job_bg_1","chunk":${JSON.stringify(streamChunk)}},"created_at":"${startedAt}"}`,
      ``,
      `event: session.event`,
      `data: {"seq":3,"session_id":"session_cli_2","run_id":"job_bg_1","type":"assistant.completed","payload":{"job_id":"job_bg_1","run_id":"job_bg_1"},"created_at":"${finishedAt}"}`,
      ``,
      `event: session.event`,
      `data: {"seq":4,"session_id":"session_cli_2","run_id":"job_bg_1","type":"run.completed","payload":{"job_id":"job_bg_1"},"created_at":"${finishedAt}"}`,
      ``,
      ``,
    ].join("\n");
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: streamBody,
    });
  });
  await page.route("**/v1/codex/sessions/discover", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        operation: "codex_sessions_discover",
        summary: {
          total: 1,
          succeeded: 1,
          failed: 0,
          fanout: 1,
          duration_ms: 5,
          started_at: "2026-03-03T00:00:00Z",
          finished_at: "2026-03-03T00:00:00Z",
        },
        targets: [
          {
            host: {
              id: "local_1",
              name: "local-default",
              connection_mode: "local",
              host: "localhost",
              user: "",
              port: 22,
              workspace: "/srv/work",
            },
            ok: true,
            sessions: [
              {
                session_id: "session_cli_1",
                thread_name: "Session 1",
                cwd: "/srv/work",
                path: "/home/ecs-user/.codex/sessions/session_cli_1.jsonl",
                updated_at: "2026-03-03T00:00:00Z",
                size_bytes: 128,
              },
            ],
          },
        ],
      },
    });
  });

  await page.route("**/v1/jobs/run", async (route) => {
    runReqCount += 1;
    await route.fulfill({
      status: 202,
      json: {
        job: {
          id: "job_ux_1",
          type: "run",
          status: "pending",
          runtime: "codex",
          prompt_preview: `prompt-${marker}`,
          queued_at: "2026-03-03T00:00:00Z",
          total_hosts: 1,
          fanout: 1,
        },
      },
    });
  });
  await page.route("**/v1/jobs/job_ux_1", async (route) => {
    jobPollCount += 1;
    if (jobPollCount <= jobRunningPolls) {
      await route.fulfill({
        status: 200,
        json: {
          job: {
            id: "job_ux_1",
            type: "run",
            status: "running",
            runtime: "codex",
            prompt_preview: "prompt",
            queued_at: "2026-03-03T00:00:00Z",
            started_at: "2026-03-03T00:00:01Z",
          },
        },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        job: {
          id: "job_ux_1",
          type: "run",
          status: "succeeded",
          runtime: "codex",
          prompt_preview: "prompt",
          queued_at: "2026-03-03T00:00:00Z",
          started_at: "2026-03-03T00:00:01Z",
          finished_at: "2026-03-03T00:00:02Z",
          result_status: 200,
          total_hosts: 1,
          succeeded_hosts: 1,
          failed_hosts: 0,
          fanout: 1,
          duration_ms: 1000,
          response: {
            runtime: "codex",
            summary: {
              total: 1,
              succeeded: 1,
              failed: 0,
              fanout: 1,
              retry_count: 0,
              retry_backoff_ms: 1000,
              duration_ms: 1000,
              started_at: "2026-03-03T00:00:01Z",
              finished_at: "2026-03-03T00:00:02Z",
            },
            targets: [],
          },
        },
      },
    });
  });
  await page.route("**/v1/jobs/job_ux_1/events**", async (route) => {
    if (streamPattern === "completion-once") {
      await route.fulfill({
        status: 200,
        json: {
          job_id: "job_ux_1",
          after: eventPollCount,
          next_after: eventPollCount,
          events: [],
        },
      });
      return;
    }
    eventPollCount += 1;
    if (eventPollCount > 1) {
      await route.fulfill({
        status: 200,
        json: { job_id: "job_ux_1", after: 4, next_after: 4, events: [] },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        job_id: "job_ux_1",
        after: 0,
        next_after: 4,
        events: [
          {
            seq: 1,
            job_id: "job_ux_1",
            type: "job.running",
            created_at: "2026-03-03T00:00:00Z",
          },
          {
            seq: 2,
            job_id: "job_ux_1",
            type: "target.stdout",
            host_name: "local-default",
            chunk: [
              `{"type":"thread.started","thread_id":"t_ux"}`,
              `{"type":"turn.started"}`,
              ...(titleUpdate
                ? [JSON.stringify({ type: "session.title.updated", title: titleUpdate })]
                : []),
              JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: assistantReply },
              }),
            ].join("\n") + "\n",
            created_at: "2026-03-03T00:00:00Z",
          },
          {
            seq: 3,
            job_id: "job_ux_1",
            type: "target.done",
            host_name: "local-default",
            status: "ok",
            exit_code: 0,
            created_at: "2026-03-03T00:00:00Z",
          },
          {
            seq: 4,
            job_id: "job_ux_1",
            type: "job.succeeded",
            created_at: "2026-03-03T00:00:01Z",
          },
        ],
      },
    });
  });
  await page.route("**/v1/jobs**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname !== "/v1/jobs") {
      await route.fallback();
      return;
    }
    const status = jobPollCount <= jobRunningPolls ? "running" : "succeeded";
    await route.fulfill({
      status: 200,
      json: {
        jobs: [
          {
            id: "job_ux_1",
            type: "run",
            status,
            runtime: "codex",
            prompt_preview: "prompt",
            queued_at: "2026-03-03T00:00:00Z",
            result_status: status === "succeeded" ? 200 : undefined,
            total_hosts: 1,
            succeeded_hosts: status === "succeeded" ? 1 : 0,
            failed_hosts: 0,
            fanout: 1,
            duration_ms: status === "succeeded" ? 1000 : 0,
          },
        ],
      },
    });
  });

  return {
    runRequests: () => runReqCount,
  };
}

async function unlock(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("rlm_xxx.yyy").fill("rlm_test.token");
  await page.getByRole("button", { name: "Unlock Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
}

test("desktop session UX baseline (layout + interaction + scroll)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `UX_MARKER_${Date.now()}`;
  const assistantReply = buildLongAssistantReply(marker);
  const harness = await mockSessionApi(page, assistantReply, marker);
  await unlock(page);

  const sidebar = page.locator(".session-side");
  const chatPane = page.locator(".chat-pane");
  await expect(sidebar).toBeVisible();
  await expect(chatPane).toBeVisible();
  await expect(page.locator(".chat-context")).toContainText(
    "local-default · /srv/work",
  );
  const sideBox = await sidebar.boundingBox();
  const chatBox = await chatPane.boundingBox();
  expect(sideBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect(Math.abs((chatBox?.y ?? 0) - (sideBox?.y ?? 0)) <= 40).toBeTruthy();
  expect((chatBox?.width ?? 0) >= 600).toBeTruthy();

  const projectFilter = page.getByPlaceholder("Filter projects or sessions");
  await expect(projectFilter).toBeVisible();
  await projectFilter.fill("session 1");
  await expect(page.locator(".session-chip-tree")).toHaveCount(1);
  await projectFilter.fill("not-found-session");
  await expect(
    page.getByText("No matching projects or sessions."),
  ).toBeVisible();
  await projectFilter.fill("");
  await page.getByRole("button", { name: "Collapse" }).first().click();
  await expect(
    page.getByRole("button", { name: "Expand" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand" }).first().click();

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await composer.fill("line-a");
  await composer.press("Shift+Enter");
  await composer.type("line-b");
  await expect(composer).toHaveValue("line-a\nline-b");
  const initialHeight = await composer.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).height),
  );
  await composer.fill(
    Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n"),
  );
  const expandedHeight = await composer.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).height),
  );
  expect(expandedHeight > initialHeight).toBeTruthy();

  await composer.fill(`reply once with marker: ${marker}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const assistantWithMarker = page.locator(".message.message-assistant pre", {
    hasText: marker,
  });
  await expect(assistantWithMarker).toHaveCount(1);
  await expect(page.getByText(/"type":"thread.started"/)).toHaveCount(0);
  await expect(page.getByText(/^Done\.$/)).toHaveCount(0);

  const timeline = page.locator(".timeline");
  const scrollGap = await timeline.evaluate((el) =>
    Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop),
  );
  expect(scrollGap <= 48).toBeTruthy();
});

test("session stream completion keeps a single assistant reply", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `STREAM_ONCE_${Date.now()}`;
  const harness = await mockSessionApi(page, `single reply ${marker}`, marker, {
    streamPattern: "completion-once",
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await composer.fill(`reply once with marker: ${marker}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const assistantWithMarker = page.locator(".message.message-assistant pre", {
    hasText: marker,
  });
  await expect(assistantWithMarker).toHaveCount(1);
  await page.waitForTimeout(1800);
  await expect(assistantWithMarker).toHaveCount(1);
  await expect(page.getByText(/"type":"thread.started"/)).toHaveCount(0);
  await expect(page.getByText(/^Done\.$/)).toHaveCount(0);
});

test("historical stream replay on refresh does not trigger session alerts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `HIST_${Date.now()}`;
  await mockSessionApi(page, `historical reply ${marker}`, marker, {
    streamPattern: "completion-once",
  });
  await unlock(page);

  await page.waitForTimeout(1800);
  await expect(page.locator(".session-alert")).toHaveCount(0);
  await expect(page.locator(".session-chip-badge.unread")).toHaveCount(0);
});

test("session tree keyboard nav and prefs survive reload", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `TREE_${Date.now()}`;
  await mockSessionApi(page, `tree reply ${marker}`, marker, {
    includeSecondSession: true,
  });
  await unlock(page);

  const sessionOne = page.locator(
    '.session-chip-tree[data-session-id="session_cli_1"]',
  );
  const sessionTwo = page.locator(
    '.session-chip-tree[data-session-id="session_cli_2"]',
  );
  await expect(sessionOne).toBeVisible();
  await expect(sessionTwo).toBeVisible();

  await sessionOne.focus();
  await page.keyboard.press("ArrowDown");
  await expect(sessionTwo).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sessionTwo).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "Session 2" })).toBeVisible();

  const projectFilter = page.getByPlaceholder("Filter projects or sessions");
  await projectFilter.fill("session 2");
  await page.getByRole("button", { name: "Collapse" }).first().click();
  await expect(
    page.getByRole("button", { name: "Expand" }).first(),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(projectFilter).toHaveValue("session 2");
  await expect(
    page.getByRole("button", { name: "Expand" }).first(),
  ).toBeVisible();
});

test("background completion shows one alert and unread badge", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `BG_${Date.now()}`;
  await mockSessionApi(page, `background ${marker}`, marker, {
    includeSecondSession: true,
    backgroundCompletion: true,
  });
  await unlock(page);

  const alert = page.locator(".session-alert", {
    hasText: "Session 2 completed",
  });
  await expect(alert).toBeVisible();
  await expect(page.locator(".session-alert")).toHaveCount(1);
  await expect(
    page.locator(
      '.session-chip-tree[data-session-id="session_cli_2"] .session-chip-badge.unread',
    ),
  ).toHaveCount(1);

  await alert.click();
  await expect(
    page.locator('.session-chip-tree[data-session-id="session_cli_2"]'),
  ).toHaveClass(/active/);
  await expect(
    page.locator(
      '.session-chip-tree[data-session-id="session_cli_2"] .session-chip-badge.unread',
    ),
  ).toHaveCount(0);
});

test("generic session title is auto-derived from first prompt", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `TITLE_${Date.now()}`;
  await mockSessionApi(page, `title ${marker}`, marker);
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await expect(page.getByRole("heading", { name: "Session 1" })).toBeVisible();
  await composer.fill("Plan deployment rollback strategy for staging API");
  await composer.press("Enter");

  await expect(
    page.getByRole("heading", {
      name: /Plan deployment rollback strategy for staging API/i,
    }),
  ).toBeVisible();
  await expect(
    page.locator('.session-chip-tree[data-session-id="session_cli_1"]'),
  ).toContainText(/Plan deployment rollback strategy for staging API/i);
});

test("session title stream update overrides fallback title", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `TITLE_EVT_${Date.now()}`;
  await mockSessionApi(page, `title-evt ${marker}`, marker, {
    titleUpdate: "QA Release Checklist",
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await composer.fill("Create rollout checklist for QA and release validation");
  await composer.press("Enter");

  await expect(
    page.getByRole("heading", { name: "QA Release Checklist" }),
  ).toBeVisible();
  await expect(
    page.locator('.session-chip-tree[data-session-id="session_cli_1"]'),
  ).toContainText("QA Release Checklist");
});

test("running state locks session controls then unlocks on completion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `LOCK_${Date.now()}`;
  await mockSessionApi(page, `lock ${marker}`, marker, { jobRunningPolls: 4 });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  const runningButton = page.getByRole("button", { name: "Running..." });
  const modelSelect = page.locator(".session-inline-settings select").first();
  const sandboxSelect = page.locator(".session-inline-settings select").nth(1);
  const attachInput = page.locator('.file-chip input[type="file"]');

  await composer.fill(`reply once with marker: ${marker}`);
  await composer.press("Enter");

  await expect(page.getByText("Codex is thinking...")).toBeVisible();
  await expect(runningButton).toBeDisabled();
  await expect(modelSelect).toBeDisabled();
  await expect(sandboxSelect).toBeDisabled();
  await expect(attachInput).toBeDisabled();

  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({
    timeout: 18000,
  });
  await expect(modelSelect).toBeEnabled();
  await expect(sandboxSelect).toBeEnabled();
  await expect(attachInput).toBeEnabled();
});

test("pinning session reorders tree and persists across reload", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PIN_${Date.now()}`;
  await mockSessionApi(page, `pin ${marker}`, marker, { includeSecondSession: true });
  await unlock(page);

  const sessionTwo = page.locator(
    '.session-chip-tree[data-session-id="session_cli_2"]',
  );
  await sessionTwo.focus();
  await page.keyboard.press("p");
  await expect(
    page.locator(
      '.session-chip-tree[data-session-id="session_cli_2"] .session-chip-badge.pinned',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator(".project-session-list .session-chip-tree").first(),
  ).toHaveAttribute("data-session-id", "session_cli_2");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(
    page.locator(
      '.session-chip-tree[data-session-id="session_cli_2"] .session-chip-badge.pinned',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator(".project-session-list .session-chip-tree").first(),
  ).toHaveAttribute("data-session-id", "session_cli_2");
});

test.use({ viewport: { width: 390, height: 844 } });
test("mobile session UX baseline (stacked layout + no horizontal overflow)", async ({
  page,
}) => {
  const marker = `MOBILE_${Date.now()}`;
  await mockSessionApi(page, `mobile ${marker}`, marker);
  await unlock(page);

  const side = page.locator(".session-side");
  const chat = page.locator(".chat-pane");
  await expect(side).toBeVisible();
  await expect(chat).toBeVisible();
  const sideBox = await side.boundingBox();
  const chatBox = await chat.boundingBox();
  expect(sideBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect((chatBox?.y ?? 0) > (sideBox?.y ?? 0)).toBeTruthy();

  const overflowX = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflowX <= 2).toBeTruthy();

  await expect(
    page.getByPlaceholder("Tell codex what to do in this workspace..."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});
