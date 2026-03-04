import { expect, test, type Page } from "@playwright/test";

type MockHarness = {
  runRequests: () => number;
  sessionOneStreamAfterValues: () => number[];
  imageUploads: () => number;
  lastRunRequest: () => Record<string, unknown> | null;
};

type MockOptions = {
  streamPattern?: "ready-only" | "completion-once";
  includeSecondSession?: boolean;
  backgroundCompletion?: boolean;
  titleUpdate?: string;
  jobRunningPolls?: number;
  streamFailAttempts?: number;
  runtimeCommandEvents?: boolean;
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
  let imageUploadCount = 0;
  let lastRunRequest: Record<string, unknown> | null = null;
  const streamPattern = options?.streamPattern ?? "ready-only";
  const includeSecondSession = options?.includeSecondSession ?? false;
  const backgroundCompletion = options?.backgroundCompletion ?? false;
  const titleUpdate = options?.titleUpdate?.trim() ?? "";
  const jobRunningPolls = Math.max(1, options?.jobRunningPolls ?? 1);
  const streamFailAttempts = Math.max(0, options?.streamFailAttempts ?? 0);
  const runtimeCommandEvents = options?.runtimeCommandEvents ?? false;
  let sessionOneStreamAttempts = 0;
  const sessionOneStreamAfterValues: number[] = [];
  let canceled = false;
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
  const projectRecords: Array<{
    id: string;
    host_id: string;
    host_name: string;
    path: string;
    title?: string;
    runtime: string;
    created_at: string;
    updated_at: string;
  }> = [
    {
      id: "project_local_1__srv_work",
      host_id: "local_1",
      host_name: "local-default",
      path: "/srv/work",
      title: "work",
      runtime: "codex",
      created_at: "2026-03-03T00:00:00Z",
      updated_at: "2026-03-03T00:00:00Z",
    },
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
  await page.route("**/v1/files/images", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    imageUploadCount += 1;
    const id = imageUploadCount.toString().padStart(2, "0");
    await route.fulfill({
      status: 200,
      json: {
        path: `/tmp/uploads/mock-image-${id}.png`,
        name: `mock-image-${id}.png`,
        bytes: 12,
      },
    });
  });
  await page.route("**/v1/projects**", async (route, request) => {
    const method = request.method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        json: {
          projects: projectRecords,
        },
      });
      return;
    }
    if (method === "POST") {
      const bodyRaw = request.postData() ?? "{}";
      const body = JSON.parse(bodyRaw) as {
        id?: string;
        host_id?: string;
        host_name?: string;
        path?: string;
        title?: string;
        runtime?: string;
      };
      const hostID = (body.host_id ?? "").trim();
      const path = (body.path ?? "").trim();
      const id = (body.id ?? "").trim() || `project_${hostID}::${path}`;
      const now = new Date().toISOString();
      const existingIndex = projectRecords.findIndex((item) => item.id === id);
      const existing = existingIndex >= 0 ? projectRecords[existingIndex] : null;
      const nextRecord = {
        id,
        host_id: hostID || existing?.host_id || "local_1",
        host_name:
          (body.host_name ?? "").trim() ||
          existing?.host_name ||
          "local-default",
        path: path || existing?.path || "/srv/work",
        title: (body.title ?? "").trim() || existing?.title || undefined,
        runtime: (body.runtime ?? "").trim() || existing?.runtime || "codex",
        created_at: existing?.created_at || now,
        updated_at: now,
      };
      if (existingIndex >= 0) {
        projectRecords[existingIndex] = nextRecord;
      } else {
        projectRecords.push(nextRecord);
      }
      await route.fulfill({
        status: 200,
        json: {
          project: nextRecord,
        },
      });
      return;
    }
    await route.fallback();
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
    const url = new URL(route.request().url());
    const streamAfterRaw = url.searchParams.get("after") ?? "0";
    const streamAfter = Number.parseInt(streamAfterRaw, 10);
    const safeStreamAfter = Number.isFinite(streamAfter) && streamAfter > 0
      ? streamAfter
      : 0;
    sessionOneStreamAfterValues.push(safeStreamAfter);
    if (sessionOneStreamAttempts < streamFailAttempts) {
      sessionOneStreamAttempts += 1;
      await route.fulfill({
        status: 503,
        body: "stream temporarily unavailable",
      });
      return;
    }
    if (streamPattern === "completion-once") {
      const chunkLines = [
        `{"type":"thread.started","thread_id":"t_ux"}`,
        `{"type":"turn.started"}`,
      ];
      if (runtimeCommandEvents) {
        chunkLines.push(
          JSON.stringify({
            type: "item.started",
            item: {
              id: "item_cmd_1",
              type: "command_execution",
              command: "ls -la",
              aggregated_output: "",
              exit_code: null,
              status: "in_progress",
            },
          }),
        );
        chunkLines.push(
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "item_cmd_1",
              type: "command_execution",
              command: "ls -la",
              aggregated_output: "README.md",
              exit_code: 0,
              status: "completed",
            },
          }),
        );
      }
      chunkLines.push(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: assistantReply },
        }),
      );
      const chunk = `${chunkLines.join("\n")}\n`;
      const events = [
        {
          seq: 1,
          type: "run.started",
          payload: { job_id: "job_ux_1" },
          createdAt: "2026-03-03T00:00:00Z",
        },
        {
          seq: 2,
          type: "target.started",
          payload: { job_id: "job_ux_1", host_name: "local-default", attempt: 1 },
          createdAt: "2026-03-03T00:00:00Z",
        },
        {
          seq: 3,
          type: "assistant.delta",
          payload: { job_id: "job_ux_1", chunk },
          createdAt: "2026-03-03T00:00:00Z",
        },
        {
          seq: 4,
          type: "target.done",
          payload: { job_id: "job_ux_1", host_name: "local-default", status: "ok", exit_code: 0 },
          createdAt: "2026-03-03T00:00:01Z",
        },
        {
          seq: 5,
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
      const replayEvents = events.filter((event) => event.seq > safeStreamAfter);
      const streamLines: string[] = [
        `event: session.ready`,
        `data: {"session_id":"session_cli_1","cursor":${safeStreamAfter}}`,
        ``,
      ];
      for (const event of replayEvents) {
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

  await page.route("**/v1/jobs/run", async (route, request) => {
    runReqCount += 1;
    try {
      const bodyRaw = request.postData() ?? "{}";
      const parsed = JSON.parse(bodyRaw) as Record<string, unknown>;
      lastRunRequest = parsed;
    } catch {
      lastRunRequest = null;
    }
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
    if (canceled) {
      await route.fulfill({
        status: 200,
        json: {
          job: {
            id: "job_ux_1",
            type: "run",
            status: "canceled",
            runtime: "codex",
            prompt_preview: "prompt",
            queued_at: "2026-03-03T00:00:00Z",
            started_at: "2026-03-03T00:00:01Z",
            finished_at: "2026-03-03T00:00:02Z",
            result_status: 499,
            total_hosts: 1,
            succeeded_hosts: 0,
            failed_hosts: 0,
            fanout: 1,
            duration_ms: 1000,
            error: "canceled while running",
            response: {
              runtime: "codex",
              summary: {
                total: 1,
                succeeded: 0,
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
      return;
    }
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
    if (canceled) {
      await route.fulfill({
        status: 200,
        json: {
          job_id: "job_ux_1",
          after: eventPollCount,
          next_after: Math.max(eventPollCount, 3),
          events: [
            {
              seq: 2,
              job_id: "job_ux_1",
              type: "job.cancel_requested",
              created_at: "2026-03-03T00:00:01Z",
            },
            {
              seq: 3,
              job_id: "job_ux_1",
              type: "job.canceled",
              created_at: "2026-03-03T00:00:02Z",
            },
          ],
        },
      });
      return;
    }
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
  await page.route("**/v1/jobs/job_ux_1/cancel", async (route) => {
    canceled = true;
    await route.fulfill({
      status: 200,
      json: {
        state: "cancel_requested",
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
    const status = canceled
      ? "canceled"
      : jobPollCount <= jobRunningPolls
        ? "running"
        : "succeeded";
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
    sessionOneStreamAfterValues: () => [...sessionOneStreamAfterValues],
    imageUploads: () => imageUploadCount,
    lastRunRequest: () => lastRunRequest,
  };
}

async function unlock(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("rlm_xxx.yyy").fill("rlm_test.token");
  await page.getByRole("button", { name: "Unlock Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
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

test("composer supports image paste and drag-drop upload", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `IMG_ATTACH_${Date.now()}`;
  const harness = await mockSessionApi(page, `img ${marker}`, marker);
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  const composerPanel = page.locator(".composer");

  await composer.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File(["img-paste"], "paste.png", { type: "image/png" }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    node.dispatchEvent(event);
  });
  await expect.poll(() => harness.imageUploads()).toBe(1);
  await expect(page.getByRole("button", { name: /mock-image-01\.png/i })).toBeVisible();

  await composerPanel.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File(["img-drop"], "drop.png", { type: "image/png" }));
    const dragEnter = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(dragEnter, "dataTransfer", { value: data });
    node.dispatchEvent(dragEnter);
  });
  await expect(page.locator(".composer-drop-indicator")).toBeVisible();

  await composerPanel.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File(["img-drop"], "drop.png", { type: "image/png" }));
    const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOver, "dataTransfer", { value: data });
    node.dispatchEvent(dragOver);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: data });
    node.dispatchEvent(drop);
  });
  await expect.poll(() => harness.imageUploads()).toBe(2);
  await expect(page.getByRole("button", { name: /mock-image-02\.png/i })).toBeVisible();
});

test("command palette executes session and model actions", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PALETTE_${Date.now()}`;
  await mockSessionApi(page, `palette ${marker}`, marker);
  await unlock(page);

  const sessionChips = page.locator(".project-session-list .session-chip-tree");
  const initialSessionCount = await sessionChips.count();

  await page.keyboard.press("Control+k");
  const paletteInput = page.getByPlaceholder("Type a command...");
  await expect(paletteInput).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Open Project: work/i }),
  ).toBeVisible();

  await paletteInput.fill("model");
  await paletteInput.press("ArrowDown");
  await paletteInput.press("Enter");
  await expect(page.locator(".command-palette-backdrop")).toHaveCount(0);
  await expect(page.getByTestId("session-model-select")).toHaveValue("gpt-5");

  await page.keyboard.press("Control+k");
  await expect(paletteInput).toBeVisible();
  await paletteInput.fill("new session");
  await paletteInput.press("Enter");
  await expect.poll(async () => sessionChips.count()).toBe(initialSessionCount + 1);
});

test("advanced codex controls map into run payload", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `ADVANCED_${Date.now()}`;
  const harness = await mockSessionApi(page, `advanced ${marker}`, marker);
  await unlock(page);

  await page.getByTestId("advanced-toggle-btn").click();
  await page.getByTestId("advanced-approval-select").selectOption("never");
  await page.getByTestId("advanced-web-search-toggle").check();
  const addDirInput = page.getByTestId("advanced-add-dir-input");
  await addDirInput.fill("/srv/extra");
  await addDirInput.press("Enter");
  await page.getByTestId("advanced-skip-git-toggle").uncheck();
  await page.getByTestId("advanced-ephemeral-toggle").check();

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await composer.fill(`advanced settings ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return String(req?.codex?.ask_for_approval ?? "");
  }).toBe("never");
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return Boolean(req?.codex?.search);
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    const dirs = req?.codex?.add_dirs;
    return Array.isArray(dirs) && dirs.includes("/srv/extra");
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return Boolean(req?.codex?.ephemeral);
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return Boolean(req?.codex?.skip_git_repo_check);
  }).toBe(false);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return Boolean(req?.codex?.json_output);
  }).toBe(true);
});

test("resume mode maps resume selector into run payload", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `RESUME_${Date.now()}`;
  const harness = await mockSessionApi(page, `resume ${marker}`, marker);
  await unlock(page);

  await page.getByTestId("lifecycle-mode-select").selectOption("resume");
  const resumeLastToggle = page.getByTestId("resume-last-toggle");
  await resumeLastToggle.uncheck();
  await page
    .getByTestId("resume-session-id-input")
    .fill("019cb3d9-002a-7b22-969e-ef24dcad7b7c");
  const composer = page.getByPlaceholder("Optional follow-up prompt for resume...");
  await composer.fill("");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => harness.runRequests()).toBe(1);

  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return String(req?.codex?.mode ?? "");
  }).toBe("resume");
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return Boolean(req?.codex?.resume_last);
  }).toBe(false);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return String(req?.codex?.session_id ?? "");
  }).toBe("019cb3d9-002a-7b22-969e-ef24dcad7b7c");
});

test("review mode maps review options into run payload", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `REVIEW_${Date.now()}`;
  const harness = await mockSessionApi(page, `review ${marker}`, marker);
  await unlock(page);

  await page.getByTestId("lifecycle-mode-select").selectOption("review");
  await page.getByTestId("review-uncommitted-toggle").check();
  await page.getByTestId("review-base-input").fill("main");
  await page.getByTestId("review-commit-input").fill("abc1234");
  await page.getByTestId("review-title-input").fill("Release review");

  const composer = page.getByPlaceholder("Optional review prompt...");
  await composer.fill("focus on risky migrations");
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return String(req?.codex?.mode ?? "");
  }).toBe("review");
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return Boolean(req?.codex?.review_uncommitted);
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return String(req?.codex?.review_base ?? "");
  }).toBe("main");
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return String(req?.codex?.review_commit ?? "");
  }).toBe("abc1234");
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { codex?: Record<string, unknown> } | null;
    return String(req?.codex?.review_title ?? "");
  }).toBe("Release review");
});

test("fork session creates a branch session in project list", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `FORK_${Date.now()}`;
  await mockSessionApi(page, `fork ${marker}`, marker);
  await unlock(page);

  const sessionChips = page.locator(".project-session-list .session-chip-tree");
  const initialCount = await sessionChips.count();
  await page.getByTestId("fork-session-btn").click();
  await expect.poll(async () => sessionChips.count()).toBe(initialCount + 1);
  await expect(page.getByRole("heading", { name: /Fork · Session 1/ })).toBeVisible();
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
  await expect(page.getByText("Response Started")).toBeVisible();
  await expect(page.getByText("Server Completed")).toBeVisible();
  await expect(page.getByText(/run=/)).toHaveCount(0);
  await expect(page.getByText(/"type":"thread.started"/)).toHaveCount(0);
  await expect(page.getByText(/^Done\.$/)).toHaveCount(0);
});

test("session stream renders command runtime cards", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `RUNTIME_CARD_${Date.now()}`;
  const harness = await mockSessionApi(page, `runtime ${marker}`, marker, {
    streamPattern: "completion-once",
    runtimeCommandEvents: true,
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await composer.fill(`emit runtime command cards ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  await expect(page.getByText("Command Started")).toBeVisible();
  await expect(page.getByText("Command Completed")).toBeVisible();
  await expect(page.getByText(/^ls -la$/)).toBeVisible();
});

test("stop and regenerate controls work in session composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `STOP_REGEN_${Date.now()}`;
  const harness = await mockSessionApi(page, `regen ${marker}`, marker, {
    jobRunningPolls: 6,
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await composer.fill(`run long task ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stopButton).toBeVisible();
  await stopButton.click();
  await expect(
    page.getByRole("heading", { name: "Stopping" }),
  ).toBeVisible();

  const regenerateButton = page.getByRole("button", { name: "Regenerate" });
  await expect(regenerateButton).toBeVisible({ timeout: 12000 });
  await regenerateButton.click();
  await expect.poll(() => harness.runRequests()).toBe(2);
});

test("user message supports edit and resend", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `EDIT_RESEND_${Date.now()}`;
  const harness = await mockSessionApi(page, `edit resend ${marker}`, marker);
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await composer.fill(`initial prompt ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
    timeout: 12000,
  });

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Edit prompt before resend");
    await dialog.accept(`edited prompt ${marker}`);
  });
  await page.getByRole("button", { name: "Edit & Resend" }).first().click();
  await expect.poll(() => harness.runRequests()).toBe(2);
  await expect(
    page.locator(".message.message-user pre", {
      hasText: `edited prompt ${marker}`,
    }),
  ).toHaveCount(1);
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

test("refresh resumes stream from persisted cursor without duplicate timeline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `CURSOR_${Date.now()}`;
  const harness = await mockSessionApi(page, `cursor reply ${marker}`, marker, {
    streamPattern: "completion-once",
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await composer.fill(`check cursor replay safety ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);
  await expect(
    page.locator(".message.message-assistant pre", { hasText: marker }),
  ).toHaveCount(1);
  await expect(page.getByText("Response Started")).toHaveCount(1);
  await expect(page.getByText("Server Completed")).toHaveCount(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(
    page.locator(".message.message-assistant pre", { hasText: marker }),
  ).toHaveCount(1);
  await expect(page.getByText("Response Started")).toHaveCount(1);
  await expect(page.getByText("Server Completed")).toHaveCount(1);
  await expect.poll(
    () => harness.sessionOneStreamAfterValues().some((value) => value > 0),
  ).toBe(true);
  await expect(page.locator(".session-alert")).toHaveCount(0);
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

test("project create and rename use project name as primary label", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PROJECT_NAME_${Date.now()}`;
  await mockSessionApi(page, `project ${marker}`, marker);
  await unlock(page);

  await page.getByRole("button", { name: "New Project" }).click();
  await page
    .getByPlaceholder("/home/ecs-user/project")
    .fill("/srv/demo-app");
  await page.getByPlaceholder("My Project").fill("Demo App");
  await page.getByRole("button", { name: "Create" }).click();

  const demoProjectNode = page.locator(".project-node", {
    has: page.locator(".project-chip-main strong", { hasText: "Demo App" }),
  });
  await expect(demoProjectNode).toBeVisible();
  await expect(demoProjectNode.locator(".project-chip-main em")).toContainText(
    "/srv/demo-app",
  );

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Project name");
    await dialog.accept("Demo App v2");
  });
  await demoProjectNode.getByRole("button", { name: "Rename" }).click();

  await expect(
    page.locator(".project-chip-main strong", { hasText: "Demo App v2" }),
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
  await expect(alert).not.toContainText(/job_|run=/i);

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
  const modelSelect = page.getByTestId("session-model-select");
  const sandboxSelect = page.getByTestId("session-sandbox-select");
  const attachInput = page.locator('.file-chip input[type="file"]');

  await composer.fill(`reply once with marker: ${marker}`);
  await composer.press("Enter");

  await expect(page.getByText("Codex is thinking...")).toBeVisible();
  await expect(runningButton).toBeDisabled();
  await expect(modelSelect).toBeDisabled();
  await expect(sandboxSelect).toBeDisabled();
  await expect(attachInput).toBeDisabled();

  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
    timeout: 18000,
  });
  await expect(modelSelect).toBeEnabled();
  await expect(sandboxSelect).toBeEnabled();
  await expect(attachInput).toBeEnabled();
});

test("stream status recovers after transient failures", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `STREAM_RECOVER_${Date.now()}`;
  await mockSessionApi(page, `recover ${marker}`, marker, {
    streamFailAttempts: 2,
  });
  await unlock(page);

  const streamStatus = page.getByTestId("stream-status");
  let sawRetryState = false;
  for (let index = 0; index < 16; index += 1) {
    const text = (await streamStatus.innerText()).toLowerCase();
    if (text.includes("reconnecting") || text.includes("stream error")) {
      sawRetryState = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  expect(sawRetryState).toBeTruthy();
  await expect(streamStatus).toContainText("stream live", { timeout: 15000 });

  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(streamStatus).toContainText("stream live", { timeout: 10000 });
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
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});
