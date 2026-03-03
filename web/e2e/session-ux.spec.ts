import { expect, test, type Page } from "@playwright/test";

type MockHarness = {
  runRequests: () => number;
};

function buildLongAssistantReply(marker: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 80; i += 1) {
    lines.push(`line-${i.toString().padStart(2, "0")} ${marker}`);
  }
  return lines.join("\n");
}

async function mockSessionApi(page: Page, assistantReply: string, marker: string): Promise<MockHarness> {
  let jobPollCount = 0;
  let eventPollCount = 0;
  let runReqCount = 0;

  await page.route("**/v1/healthz", async (route) => {
    await route.fulfill({ status: 200, json: { ok: true, timestamp: "2026-03-03T00:00:00Z" } });
  });
  await page.route("**/v1/hosts", async (route, request) => {
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        hosts: [{ id: "local_1", name: "local-default", connection_mode: "local", host: "localhost", user: "", port: 22, workspace: "/srv/work" }]
      }
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
              supports_cost_metrics: false
            }
          }
        ]
      }
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
        jobs: { total: 1, pending: 0, running: 0, succeeded: 1, failed: 0, canceled: 0, retry_attempts: 0 },
        queue: { depth: 0, workers_total: 2, workers_active: 0, worker_utilization: 0 },
        success_rate: 1
      }
    });
  });
  await page.route("**/v1/admin/retention", async (route, request) => {
    if (request.method() !== "GET" && request.method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      json: { retention: { run_records_max: 500, run_jobs_max: 1000, audit_events_max: 5000 } }
    });
  });
  await page.route("**/v1/codex/models**", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        runtime: "codex",
        default_model: "gpt-5-codex",
        models: ["gpt-5-codex", "gpt-5"]
      }
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
            updated_at: "2026-03-03T00:00:00Z"
          }
        ]
      }
    });
  });
  await page.route("**/v1/sessions?**", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        sessions: [
          {
            id: "session_cli_1",
            project_id: "project_local_1__srv_work",
            host_id: "local_1",
            path: "/srv/work",
            runtime: "codex",
            title: "Session 1",
            created_at: "2026-03-03T00:00:00Z",
            updated_at: "2026-03-03T00:00:00Z"
          }
        ]
      }
    });
  });
  await page.route("**/v1/sessions/session_cli_1/stream**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: `event: session.ready\ndata: {"session_id":"session_cli_1","cursor":0}\n\n`
    });
  });
  await page.route("**/v1/codex/sessions/discover", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        operation: "codex_sessions_discover",
        summary: { total: 1, succeeded: 1, failed: 0, fanout: 1, duration_ms: 5, started_at: "2026-03-03T00:00:00Z", finished_at: "2026-03-03T00:00:00Z" },
        targets: [
          {
            host: { id: "local_1", name: "local-default", connection_mode: "local", host: "localhost", user: "", port: 22, workspace: "/srv/work" },
            ok: true,
            sessions: [
              {
                session_id: "session_cli_1",
                thread_name: "Session 1",
                cwd: "/srv/work",
                path: "/home/ecs-user/.codex/sessions/session_cli_1.jsonl",
                updated_at: "2026-03-03T00:00:00Z",
                size_bytes: 128
              }
            ]
          }
        ]
      }
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
          fanout: 1
        }
      }
    });
  });
  await page.route("**/v1/jobs/job_ux_1", async (route) => {
    jobPollCount += 1;
    if (jobPollCount < 2) {
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
            started_at: "2026-03-03T00:00:01Z"
          }
        }
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
              finished_at: "2026-03-03T00:00:02Z"
            },
            targets: []
          }
        }
      }
    });
  });
  await page.route("**/v1/jobs/job_ux_1/events**", async (route) => {
    eventPollCount += 1;
    if (eventPollCount > 1) {
      await route.fulfill({ status: 200, json: { job_id: "job_ux_1", after: 4, next_after: 4, events: [] } });
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        job_id: "job_ux_1",
        after: 0,
        next_after: 4,
        events: [
          { seq: 1, job_id: "job_ux_1", type: "job.running", created_at: "2026-03-03T00:00:00Z" },
          {
            seq: 2,
            job_id: "job_ux_1",
            type: "target.stdout",
            host_name: "local-default",
            chunk:
              `{"type":"thread.started","thread_id":"t_ux"}\n` +
              `{"type":"turn.started"}\n` +
              `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: assistantReply } })}\n`,
            created_at: "2026-03-03T00:00:00Z"
          },
          { seq: 3, job_id: "job_ux_1", type: "target.done", host_name: "local-default", status: "ok", exit_code: 0, created_at: "2026-03-03T00:00:00Z" },
          { seq: 4, job_id: "job_ux_1", type: "job.succeeded", created_at: "2026-03-03T00:00:01Z" }
        ]
      }
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
    const status = jobPollCount < 2 ? "running" : "succeeded";
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
            duration_ms: status === "succeeded" ? 1000 : 0
          }
        ]
      }
    });
  });

  return {
    runRequests: () => runReqCount
  };
}

async function unlock(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("rlm_xxx.yyy").fill("rlm_test.token");
  await page.getByRole("button", { name: "Unlock Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
}

test("desktop session UX baseline (layout + interaction + scroll)", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `UX_MARKER_${Date.now()}`;
  const assistantReply = buildLongAssistantReply(marker);
  const harness = await mockSessionApi(page, assistantReply, marker);
  await unlock(page);

  const sidebar = page.locator(".session-side");
  const chatPane = page.locator(".chat-pane");
  await expect(sidebar).toBeVisible();
  await expect(chatPane).toBeVisible();
  const sideBox = await sidebar.boundingBox();
  const chatBox = await chatPane.boundingBox();
  expect(sideBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect(Math.abs((chatBox?.y ?? 0) - (sideBox?.y ?? 0)) <= 40).toBeTruthy();
  expect((chatBox?.width ?? 0) >= 600).toBeTruthy();

  const composer = page.getByPlaceholder("Tell codex what to do in this workspace...");
  await composer.fill("line-a");
  await composer.press("Shift+Enter");
  await composer.type("line-b");
  await expect(composer).toHaveValue("line-a\nline-b");

  await composer.fill(`reply once with marker: ${marker}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const assistantWithMarker = page.locator(".message.message-assistant pre", { hasText: marker });
  await expect(assistantWithMarker).toHaveCount(1);
  await expect(page.getByText(/"type":"thread.started"/)).toHaveCount(0);
  await expect(page.getByText(/^Done\.$/)).toHaveCount(0);

  const timeline = page.locator(".timeline");
  const scrollGap = await timeline.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop));
  expect(scrollGap <= 48).toBeTruthy();
});

test.use({ viewport: { width: 390, height: 844 } });
test("mobile session UX baseline (stacked layout + no horizontal overflow)", async ({ page }) => {
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

  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflowX <= 2).toBeTruthy();

  await expect(page.getByPlaceholder("Tell codex what to do in this workspace...")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});
