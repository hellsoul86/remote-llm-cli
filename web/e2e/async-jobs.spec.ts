import { expect, test, type Page } from "@playwright/test";

type StreamScenario = "success" | "assistant" | "failure";

type MockHarness = {
  turnRequests: () => number;
  lastTurnRequest: () => Record<string, unknown> | null;
};

async function mockSessionApi(
  page: Page,
  scenario: StreamScenario,
): Promise<MockHarness> {
  let turnReqCount = 0;
  let lastTurnRequest: Record<string, unknown> | null = null;

  const sessions = [
    {
      id: "session_cli_1",
      project_id: "project_local_1__srv_work",
      title: "Session 1",
      updated_at: "2026-03-03T00:00:00Z",
      created_at: "2026-03-03T00:00:00Z",
    },
  ];

  const projects = [
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

  await page.route("**/v1/jobs**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, json: { jobs: [] } });
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
          total: 0,
          pending: 0,
          running: 0,
          succeeded: 0,
          failed: 0,
          canceled: 0,
          retry_attempts: 0,
        },
        queue: {
          depth: 0,
          workers_total: 1,
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

  await page.route("**/v1/projects**", async (route, request) => {
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, json: { projects } });
  });

  await page.route("**/v1/sessions?**", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        sessions: sessions.map((session) => ({
          id: session.id,
          project_id: session.project_id,
          host_id: "local_1",
          path: "/srv/work",
          runtime: "codex",
          title: session.title,
          created_at: session.created_at,
          updated_at: session.updated_at,
        })),
      },
    });
  });

  await page.route(
    "**/v2/codex/sessions/session_cli_1/turns/start",
    async (route, request) => {
      turnReqCount += 1;
      try {
        const bodyRaw = request.postData() ?? "{}";
        lastTurnRequest = JSON.parse(bodyRaw) as Record<string, unknown>;
      } catch {
        lastTurnRequest = null;
      }
      await route.fulfill({
        status: 200,
        json: {
          turn_id: `turn_${turnReqCount}`,
        },
      });
    },
  );

  await page.route(
    "**/v2/codex/sessions/session_cli_1/turns/*/interrupt",
    async (route) => {
      await route.fulfill({ status: 200, json: { ok: true } });
    },
  );

  await page.route(
    "**/v2/codex/sessions/session_cli_1/requests/pending",
    async (route, request) => {
      if (request.method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          requests: [],
        },
      });
    },
  );

  await page.route(
    "**/v2/codex/sessions/session_cli_1/requests/*/resolve",
    async (route, request) => {
      if (request.method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          resolved: true,
          session_id: "session_cli_1",
          request_id: "req_1",
        },
      });
    },
  );

  const fulfillSessionStream = async (route: Parameters<Page["route"]>[1] extends (route: infer T, ...args: infer _R) => any ? T : never) => {
    const url = new URL(route.request().url());
    const afterRaw = url.searchParams.get("after") ?? "0";
    const after = Number.parseInt(afterRaw, 10);
    const safeAfter = Number.isFinite(after) && after > 0 ? after : 0;

    const runID = turnReqCount > 0 ? `turn_${turnReqCount}` : "turn_1";
    const events: Array<Record<string, unknown>> = [];
    if (turnReqCount > 0) {
      if (scenario === "success") {
        events.push(
          {
            seq: 1,
            session_id: "session_cli_1",
            run_id: runID,
            type: "run.started",
            payload: { turn_id: runID },
            created_at: "2026-03-03T00:00:00Z",
          },
          {
            seq: 2,
            session_id: "session_cli_1",
            run_id: runID,
            type: "assistant.delta",
            payload: {
              chunk:
                '{"type":"thread.started","thread_id":"t_1"}\n' +
                '{"type":"turn.started"}\n' +
                '{"type":"item.completed","item":{"type":"agent_message","text":"stream-one"}}\n',
            },
            created_at: "2026-03-03T00:00:00Z",
          },
          {
            seq: 3,
            session_id: "session_cli_1",
            run_id: runID,
            type: "assistant.completed",
            payload: { turn_id: runID },
            created_at: "2026-03-03T00:00:01Z",
          },
          {
            seq: 4,
            session_id: "session_cli_1",
            run_id: runID,
            type: "run.completed",
            payload: { turn_id: runID },
            created_at: "2026-03-03T00:00:01Z",
          },
        );
      } else if (scenario === "assistant") {
        events.push(
          {
            seq: 1,
            session_id: "session_cli_1",
            run_id: runID,
            type: "run.started",
            payload: { turn_id: runID },
            created_at: "2026-03-03T00:00:00Z",
          },
          {
            seq: 2,
            session_id: "session_cli_1",
            run_id: runID,
            type: "assistant.delta",
            payload: {
              chunk:
                '{"type":"item.completed","item":{"type":"agent_message","text":"Remote codex response line 1\\nRemote codex response line 2"}}\n',
            },
            created_at: "2026-03-03T00:00:00Z",
          },
          {
            seq: 3,
            session_id: "session_cli_1",
            run_id: runID,
            type: "assistant.completed",
            payload: { turn_id: runID },
            created_at: "2026-03-03T00:00:01Z",
          },
          {
            seq: 4,
            session_id: "session_cli_1",
            run_id: runID,
            type: "run.completed",
            payload: { turn_id: runID },
            created_at: "2026-03-03T00:00:01Z",
          },
        );
      } else {
        events.push(
          {
            seq: 1,
            session_id: "session_cli_1",
            run_id: runID,
            type: "run.started",
            payload: { turn_id: runID },
            created_at: "2026-03-03T00:00:00Z",
          },
          {
            seq: 2,
            session_id: "session_cli_1",
            run_id: runID,
            type: "target.done",
            payload: {
              host_name: "local-default",
              status: "failed",
              exit_code: 1,
              error: "local command failed: exit status 1",
            },
            created_at: "2026-03-03T00:00:00Z",
          },
          {
            seq: 3,
            session_id: "session_cli_1",
            run_id: runID,
            type: "run.completed",
            payload: { turn_id: runID },
            created_at: "2026-03-03T00:00:01Z",
          },
        );
      }
    }

    const replay = events.filter((event) => {
      const seq = typeof event.seq === "number" ? event.seq : 0;
      return seq > safeAfter;
    });

    const streamLines: string[] = [
      "event: session.ready",
      `data: ${JSON.stringify({ session_id: "session_cli_1", cursor: safeAfter })}`,
      "",
    ];
    for (const event of replay) {
      const seq = typeof event.seq === "number" ? String(event.seq) : "";
      if (seq) {
        streamLines.push(`id: ${seq}`);
      }
      streamLines.push("event: session.event");
      streamLines.push(`data: ${JSON.stringify(event)}`);
      streamLines.push("");
    }
    streamLines.push("");

    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: streamLines.join("\n"),
    });
  };

  await page.route("**/v2/codex/sessions/session_cli_1/stream**", async (route) => {
    await fulfillSessionStream(route);
  });

  await page.route("**/v1/sessions/session_cli_1/stream**", async (route) => {
    await fulfillSessionStream(route);
  });

  return {
    turnRequests: () => turnReqCount,
    lastTurnRequest: () => lastTurnRequest,
  };
}

async function unlock(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("rlm_xxx.yyy").fill("rlm_test.token");
  await page.getByRole("button", { name: "Unlock Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
}

test("queues codex v2 turn and renders stream completion", async ({ page }) => {
  const harness = await mockSessionApi(page, "success");
  await unlock(page);

  const composer = page.getByPlaceholder("Tell codex what to do in this workspace...");
  await composer.fill("smoke");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");

  await expect.poll(() => harness.turnRequests()).toBe(1);
  await expect.poll(() => {
    const req = harness.lastTurnRequest();
    const input = Array.isArray(req?.input) ? req.input : [];
    const first = input[0] as { type?: string; text?: string } | undefined;
    return `${String(first?.type ?? "")}:${String(first?.text ?? "")}`;
  }).toBe("text:smoke");

  await expect(page.getByText(/stream-one/)).toBeVisible();
  await expect(page.getByText(/"type":"thread.started"/)).toHaveCount(0);
  await expect(page.getByText(/^Done\.$/)).toHaveCount(0);
});

test("renders assistant response from v2 stream delta", async ({ page }) => {
  const harness = await mockSessionApi(page, "assistant");
  await unlock(page);

  const composer = page.getByPlaceholder("Tell codex what to do in this workspace...");
  await composer.fill("smoke");
  await composer.press("Enter");

  await expect.poll(() => harness.turnRequests()).toBe(1);
  await expect(page.getByText(/Remote codex response line 1/)).toBeVisible();
  await expect(page.getByText(/Remote codex response line 2/)).toBeVisible();
  await expect(page.getByText(/^Done\.$/)).toHaveCount(0);
});

test("shows target failure details when v2 stream reports failed target", async ({ page }) => {
  const harness = await mockSessionApi(page, "failure");
  await unlock(page);

  const composer = page.getByPlaceholder("Tell codex what to do in this workspace...");
  await composer.fill("smoke");
  await composer.press("Enter");

  await expect.poll(() => harness.turnRequests()).toBe(1);
  await expect(page.getByText(/local-default failed/)).toBeVisible();
  await expect(page.getByText(/local command failed: exit status 1/)).toBeVisible();
  await expect(page.getByText(/^Done\.$/)).toHaveCount(0);
});
