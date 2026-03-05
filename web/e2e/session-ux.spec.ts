import { expect, test, type Page } from "@playwright/test";

type MockHarness = {
  runRequests: () => number;
  sessionOneStreamAfterValues: () => number[];
  imageUploads: () => number;
  lastRunRequest: () => Record<string, unknown> | null;
  lastPlatformLoginRequest: () => Record<string, unknown> | null;
  lastPlatformMCPRequest: () => Record<string, unknown> | null;
  lastPlatformCloudRequest: () => Record<string, unknown> | null;
};

type MockOptions = {
  streamPattern?: "ready-only" | "completion-once";
  includeSecondSession?: boolean;
  backgroundCompletion?: boolean;
  titleUpdate?: string;
  jobRunningPolls?: number;
  jobEventFirstPollDelayMS?: number;
  streamFailAttempts?: number;
  runtimeCommandEvents?: boolean;
  assistantDeltaEvents?: number;
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
  let runReqCount = 0;
  let imageUploadCount = 0;
  let lastRunRequest: Record<string, unknown> | null = null;
  let lastPlatformLoginRequest: Record<string, unknown> | null = null;
  let lastPlatformMCPRequest: Record<string, unknown> | null = null;
  let lastPlatformCloudRequest: Record<string, unknown> | null = null;

  const streamPattern = options?.streamPattern ?? "ready-only";
  const includeSecondSession = options?.includeSecondSession ?? false;
  const backgroundCompletion = options?.backgroundCompletion ?? false;
  const titleUpdate = options?.titleUpdate?.trim() ?? "";
  const jobRunningPolls = Math.max(1, options?.jobRunningPolls ?? 1);
  const jobEventFirstPollDelayMS = Math.max(
    0,
    options?.jobEventFirstPollDelayMS ?? 0,
  );
  const streamFailAttempts = Math.max(0, options?.streamFailAttempts ?? 0);
  const runtimeCommandEvents = options?.runtimeCommandEvents ?? false;
  const assistantDeltaEvents = Math.max(1, options?.assistantDeltaEvents ?? 1);

  let sessionOneStreamAttempts = 0;
  let firstTurnDelayApplied = false;
  let backgroundCompletionEmitted = false;
  let sessionStartCounter = 0;
  let forkCounter = 0;
  const sessionOneStreamAfterValues: number[] = [];

  const nowISO = new Date().toISOString();
  const sessions: Array<{
    id: string;
    project_id: string;
    title: string;
    updated_at: string;
    created_at: string;
  }> = [
    {
      id: "session_cli_1",
      project_id: "project_local_1__srv_work",
      title: "Session 1",
      updated_at: nowISO,
      created_at: "2026-03-03T00:00:00Z",
    },
    ...(includeSecondSession
      ? [
          {
            id: "session_cli_2",
            project_id: "project_local_1__srv_work",
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

  type TurnState = {
    runID: string;
    phase: "pending" | "started" | "completed" | "canceled";
    remainingPolls: number;
  };

  const turnStates: TurnState[] = [];
  const sessionOneEvents: Array<Record<string, unknown>> = [];
  const sessionTwoEvents: Array<Record<string, unknown>> = [];
  let sessionOneSeq = 0;
  let sessionTwoSeq = 0;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const nextSessionOneSeq = (): number => {
    sessionOneSeq += 1;
    return sessionOneSeq;
  };

  const nextSessionTwoSeq = (): number => {
    sessionTwoSeq += 1;
    return sessionTwoSeq;
  };

  const pushSessionOneEvent = (
    runID: string,
    type: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ) => {
    sessionOneEvents.push({
      seq: nextSessionOneSeq(),
      session_id: "session_cli_1",
      run_id: runID,
      type,
      payload,
      created_at: createdAt,
    });
  };

  const pushSessionTwoEvent = (
    runID: string,
    type: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ) => {
    sessionTwoEvents.push({
      seq: nextSessionTwoSeq(),
      session_id: "session_cli_2",
      run_id: runID,
      type,
      payload,
      created_at: createdAt,
    });
  };

  const chunkFromText = (text: string, includePrelude: boolean): string => {
    const chunkLines: string[] = [];
    if (includePrelude) {
      chunkLines.push('{"type":"thread.started","thread_id":"t_ux"}');
      chunkLines.push('{"type":"turn.started"}');
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
    }
    chunkLines.push(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text },
      }),
    );
    return `${chunkLines.join("\n")}\n`;
  };

  const appendTurnStartEvents = (turnState: TurnState) => {
    const startedAt = new Date().toISOString();
    pushSessionOneEvent(turnState.runID, "run.started", { turn_id: turnState.runID }, startedAt);
    pushSessionOneEvent(
      turnState.runID,
      "target.started",
      { host_name: "local-default", attempt: 1 },
      startedAt,
    );

    const replyLines = assistantReply.split("\n");
    for (let index = 0; index < assistantDeltaEvents; index += 1) {
      const ratio = (index + 1) / assistantDeltaEvents;
      const lineCount = Math.max(
        1,
        Math.min(replyLines.length, Math.round(replyLines.length * ratio)),
      );
      const text = replyLines.slice(0, lineCount).join("\n");
      pushSessionOneEvent(
        turnState.runID,
        "assistant.delta",
        { chunk: chunkFromText(text, index === 0) },
        startedAt,
      );
    }
  };

  const appendTurnTerminalEvents = (turnState: TurnState) => {
    const finishedAt = new Date().toISOString();
    pushSessionOneEvent(
      turnState.runID,
      "target.done",
      {
        host_name: "local-default",
        status: "ok",
        exit_code: 0,
      },
      finishedAt,
    );
    pushSessionOneEvent(
      turnState.runID,
      "assistant.completed",
      { turn_id: turnState.runID },
      finishedAt,
    );
    if (titleUpdate) {
      pushSessionOneEvent(
        turnState.runID,
        "session.title.updated",
        { title: titleUpdate },
        finishedAt,
      );
    }
    pushSessionOneEvent(
      turnState.runID,
      "run.completed",
      { turn_id: turnState.runID },
      finishedAt,
    );
  };

  const materializeSessionOneEventsForStream = async () => {
    if (streamPattern !== "completion-once" && streamPattern !== "ready-only") {
      return;
    }
    const current = turnStates.find(
      (state) => state.phase === "pending" || state.phase === "started",
    );
    if (!current) return;

    if (current.phase === "pending") {
      if (!firstTurnDelayApplied && jobEventFirstPollDelayMS > 0) {
        firstTurnDelayApplied = true;
        await sleep(jobEventFirstPollDelayMS);
      }
      appendTurnStartEvents(current);
      current.phase = "started";
    }

    if (current.phase === "started") {
      if (current.remainingPolls > 1) {
        current.remainingPolls -= 1;
        return;
      }
      appendTurnTerminalEvents(current);
      current.phase = "completed";
      current.remainingPolls = 0;
    }
  };

  const ensureSessionTwoBackgroundCompletion = () => {
    if (!includeSecondSession || !backgroundCompletion || backgroundCompletionEmitted) {
      return;
    }
    backgroundCompletionEmitted = true;
    const runID = "turn_bg_1";
    const startedAt = new Date(Date.now() - 1400).toISOString();
    const finishedAt = new Date().toISOString();
    const streamChunk =
      '{"type":"thread.started","thread_id":"t_bg"}\n' +
      '{"type":"turn.started"}\n' +
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `background reply ${marker}` } })}\n`;

    pushSessionTwoEvent(runID, "run.started", { turn_id: runID }, startedAt);
    pushSessionTwoEvent(runID, "assistant.delta", { chunk: streamChunk }, startedAt);
    pushSessionTwoEvent(runID, "assistant.completed", { turn_id: runID }, finishedAt);
    pushSessionTwoEvent(runID, "run.completed", { turn_id: runID }, finishedAt);
  };

  const buildSSEBody = (
    sessionID: string,
    cursor: number,
    allEvents: Array<Record<string, unknown>>,
  ): string => {
    const replay = allEvents.filter((event) => {
      const seq = typeof event.seq === "number" ? event.seq : 0;
      return seq > cursor;
    });
    const lines: string[] = [
      "event: session.ready",
      `data: ${JSON.stringify({ session_id: sessionID, cursor })}`,
      "",
    ];
    for (const event of replay) {
      const seq = typeof event.seq === "number" ? String(event.seq) : "";
      if (seq) {
        lines.push(`id: ${seq}`);
      }
      lines.push("event: session.event");
      lines.push(`data: ${JSON.stringify(event)}`);
      lines.push("");
    }
    lines.push("");
    return lines.join("\n");
  };

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

  await page.route("**/v1/codex/platform/login", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const bodyRaw = request.postData() ?? "{}";
    const body = JSON.parse(bodyRaw) as { action?: string };
    lastPlatformLoginRequest = body as Record<string, unknown>;
    const action = (body.action ?? "status").trim();
    const stdout =
      action === "logout"
        ? "Logged out."
        : action === "login_device"
          ? "Open browser to continue device auth."
          : "Logged in as test-user.";
    await route.fulfill({
      status: 200,
      json: {
        operation: `codex_platform_login_${action}`,
        host: {
          id: "local_1",
          name: "local-default",
          connection_mode: "local",
          host: "localhost",
          user: "",
          port: 22,
          workspace: "/srv/work",
        },
        command:
          action === "logout"
            ? ["codex", "logout"]
            : action === "login_device"
              ? ["codex", "login", "--device-auth"]
              : ["codex", "login", "status"],
        workdir: "/srv/work",
        ok: true,
        result: {
          command: "mock-codex",
          stdout,
          stderr: "",
          exit_code: 0,
          duration_ms: 11,
          started_at: "2026-03-03T00:00:00Z",
          finished_at: "2026-03-03T00:00:00Z",
        },
      },
    });
  });

  await page.route("**/v1/codex/platform/mcp", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const bodyRaw = request.postData() ?? "{}";
    const body = JSON.parse(bodyRaw) as { action?: string; name?: string };
    lastPlatformMCPRequest = body as Record<string, unknown>;
    const action = (body.action ?? "list").trim();
    const payload =
      action === "list"
        ? [{ name: "memory", transport: "http" }]
        : action === "get"
          ? { name: body.name ?? "memory", transport: "http" }
          : { ok: true, action };
    await route.fulfill({
      status: 200,
      json: {
        operation: `codex_platform_mcp_${action}`,
        host: {
          id: "local_1",
          name: "local-default",
          connection_mode: "local",
          host: "localhost",
          user: "",
          port: 22,
          workspace: "/srv/work",
        },
        command: ["codex", "mcp", action],
        workdir: "/srv/work",
        ok: true,
        result: {
          command: "mock-codex",
          stdout: JSON.stringify(payload),
          stderr: "",
          exit_code: 0,
          duration_ms: 12,
          started_at: "2026-03-03T00:00:00Z",
          finished_at: "2026-03-03T00:00:00Z",
        },
        json: payload,
      },
    });
  });

  await page.route("**/v1/codex/platform/cloud", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const bodyRaw = request.postData() ?? "{}";
    const body = JSON.parse(bodyRaw) as { action?: string; task_id?: string };
    lastPlatformCloudRequest = body as Record<string, unknown>;
    const action = (body.action ?? "list").trim();
    const stdout =
      action === "list"
        ? JSON.stringify({ tasks: [{ id: "task_1", status: "done" }] })
        : action === "status"
          ? `task ${body.task_id ?? "task_1"} done`
          : `${action} ok`;
    await route.fulfill({
      status: 200,
      json: {
        operation: `codex_platform_cloud_${action}`,
        host: {
          id: "local_1",
          name: "local-default",
          connection_mode: "local",
          host: "localhost",
          user: "",
          port: 22,
          workspace: "/srv/work",
        },
        command: ["codex", "cloud", action],
        workdir: "/srv/work",
        ok: true,
        result: {
          command: "mock-codex",
          stdout,
          stderr: "",
          exit_code: 0,
          duration_ms: 14,
          started_at: "2026-03-03T00:00:00Z",
          finished_at: "2026-03-03T00:00:00Z",
        },
        json:
          action === "list"
            ? { tasks: [{ id: "task_1", status: "done" }] }
            : undefined,
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
    if (method === "DELETE") {
      const url = new URL(request.url());
      const parts = url.pathname.split("/");
      const projectID = decodeURIComponent(parts[parts.length - 1] ?? "").trim();
      if (!projectID) {
        await route.fulfill({
          status: 400,
          json: { error: "missing project id" },
        });
        return;
      }
      const existingIndex = projectRecords.findIndex((item) => item.id === projectID);
      if (existingIndex < 0) {
        await route.fulfill({
          status: 404,
          json: { error: "project not found" },
        });
        return;
      }
      const attachedSessionCount = sessions.filter(
        (sessionItem) => sessionItem.project_id === projectID,
      ).length;
      if (attachedSessionCount > 0) {
        await route.fulfill({
          status: 409,
          json: {
            error: "project has active sessions",
            session_count: attachedSessionCount,
          },
        });
        return;
      }
      const [deleted] = projectRecords.splice(existingIndex, 1);
      await route.fulfill({
        status: 200,
        json: {
          deleted: true,
          project: deleted,
        },
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/v1/sessions?**", async (route, request) => {
    const url = new URL(request.url());
    const projectIDFilter = (url.searchParams.get("project_id") ?? "").trim();
    const filteredSessions = sessions.filter((sessionItem) => {
      if (!projectIDFilter) return true;
      return sessionItem.project_id === projectIDFilter;
    });
    await route.fulfill({
      status: 200,
      json: {
        sessions: filteredSessions.map((sessionItem) => ({
          id: sessionItem.id,
          project_id: sessionItem.project_id,
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
    const activeTurn = turnStates.find(
      (state) => state.phase === "pending" || state.phase === "started",
    );
    const latestTurn = turnStates.length > 0 ? turnStates[turnStates.length - 1] : null;
    const status = activeTurn
      ? "running"
      : latestTurn?.phase === "canceled"
        ? "canceled"
        : latestTurn
          ? "succeeded"
          : "succeeded";

    await route.fulfill({
      status: 200,
      json: {
        jobs: latestTurn
          ? [
              {
                id: latestTurn.runID,
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
            ]
          : [],
      },
    });
  });

  await page.route("**/v2/codex/sessions/start", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const bodyRaw = request.postData() ?? "{}";
    const body = JSON.parse(bodyRaw) as {
      path?: string;
      title?: string;
    };
    const path = (body.path ?? "").trim() || "/srv/work";
    const title = (body.title ?? "").trim() || `Session ${sessions.length + 1}`;

    let project = projectRecords.find((item) => item.path === path);
    if (!project) {
      project = {
        id: `project_local_1__${encodeURIComponent(path)}`,
        host_id: "local_1",
        host_name: "local-default",
        path,
        title: path.split("/").filter(Boolean).at(-1) || "project",
        runtime: "codex",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      projectRecords.push(project);
    }

    sessionStartCounter += 1;
    const sessionID = `session_cli_new_${sessionStartCounter}`;
    sessions.push({
      id: sessionID,
      project_id: project.id,
      title,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await route.fulfill({
      status: 200,
      json: {
        session: {
          id: sessionID,
          project_id: project.id,
          host_id: "local_1",
          path: project.path,
          runtime: "codex",
          title,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        project,
        thread: {
          id: sessionID,
          preview: title,
        },
      },
    });
  });

  await page.route("**/v2/codex/sessions/*/fork", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    const parts = url.pathname.split("/");
    const sourceID = decodeURIComponent(parts[4] ?? "").trim();
    const source = sessions.find((item) => item.id === sourceID);
    const bodyRaw = request.postData() ?? "{}";
    const body = JSON.parse(bodyRaw) as { title?: string };

    forkCounter += 1;
    const sessionID = `session_cli_fork_${forkCounter}`;
    const title =
      (body.title ?? "").trim() ||
      (source ? `Fork · ${source.title}` : `Fork · Session ${forkCounter}`);
    const projectID = source?.project_id ?? "project_local_1__srv_work";
    sessions.push({
      id: sessionID,
      project_id: projectID,
      title,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const project =
      projectRecords.find((item) => item.id === projectID) ?? projectRecords[0];
    await route.fulfill({
      status: 200,
      json: {
        session: {
          id: sessionID,
          project_id: project.id,
          host_id: "local_1",
          path: project.path,
          runtime: "codex",
          title,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        project,
        thread: {
          id: sessionID,
          preview: title,
        },
      },
    });
  });

  await page.route("**/v2/codex/sessions/*/archive", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    const parts = url.pathname.split("/");
    const sessionID = decodeURIComponent(parts[4] ?? "").trim();
    const index = sessions.findIndex((item) => item.id === sessionID);
    const deleted = index >= 0 ? sessions.splice(index, 1)[0] : null;
    await route.fulfill({
      status: 200,
      json: {
        archived: true,
        deleted: Boolean(deleted),
        session: deleted
          ? {
              id: deleted.id,
              project_id: deleted.project_id,
              host_id: "local_1",
              path: "/srv/work",
              runtime: "codex",
              title: deleted.title,
              created_at: deleted.created_at,
              updated_at: deleted.updated_at,
            }
          : undefined,
      },
    });
  });

  await page.route("**/v2/codex/sessions/*/turns/start", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    runReqCount += 1;
    const url = new URL(request.url());
    const parts = url.pathname.split("/");
    const sessionID = decodeURIComponent(parts[4] ?? "").trim();

    try {
      const bodyRaw = request.postData() ?? "{}";
      const parsed = JSON.parse(bodyRaw) as Record<string, unknown>;
      lastRunRequest = parsed;
    } catch {
      lastRunRequest = null;
    }

    if (!sessions.some((item) => item.id === sessionID)) {
      sessions.push({
        id: sessionID,
        project_id: "project_local_1__srv_work",
        title: `Session ${sessions.length + 1}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    const runID = `turn_${runReqCount}`;
    turnStates.push({
      runID,
      phase: "pending",
      remainingPolls: jobRunningPolls,
    });

    await route.fulfill({
      status: 200,
      json: {
        turn_id: runID,
        turn: { id: runID },
      },
    });
  });

  await page.route("**/v2/codex/sessions/*/turns/*/interrupt", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    const parts = url.pathname.split("/");
    const runID = decodeURIComponent(parts[6] ?? "").trim();
    const state = turnStates.find((item) => item.runID === runID);
    if (state && state.phase !== "completed" && state.phase !== "canceled") {
      state.phase = "canceled";
      state.remainingPolls = 0;
      pushSessionOneEvent(
        runID,
        "run.canceled",
        { turn_id: runID },
        new Date().toISOString(),
      );
    }
    await route.fulfill({
      status: 200,
      json: {
        turn_id: runID,
        interrupted: true,
      },
    });
  });

  await page.route("**/v2/codex/sessions/*/stream**", async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split("/");
    const sessionID = decodeURIComponent(parts[4] ?? "").trim();
    const streamAfterRaw = url.searchParams.get("after") ?? "0";
    const streamAfter = Number.parseInt(streamAfterRaw, 10);
    const safeStreamAfter = Number.isFinite(streamAfter) && streamAfter > 0
      ? streamAfter
      : 0;

    if (sessionID === "session_cli_1") {
      sessionOneStreamAfterValues.push(safeStreamAfter);
      if (sessionOneStreamAttempts < streamFailAttempts) {
        sessionOneStreamAttempts += 1;
        await route.fulfill({
          status: 503,
          body: "stream temporarily unavailable",
        });
        return;
      }
      await materializeSessionOneEventsForStream();
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: buildSSEBody(sessionID, safeStreamAfter, sessionOneEvents),
      });
      return;
    }

    if (sessionID === "session_cli_2") {
      ensureSessionTwoBackgroundCompletion();
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: buildSSEBody(sessionID, safeStreamAfter, sessionTwoEvents),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: buildSSEBody(sessionID, safeStreamAfter, []),
    });
  });

  return {
    runRequests: () => runReqCount,
    sessionOneStreamAfterValues: () => [...sessionOneStreamAfterValues],
    imageUploads: () => imageUploadCount,
    lastRunRequest: () => lastRunRequest,
    lastPlatformLoginRequest: () => lastPlatformLoginRequest,
    lastPlatformMCPRequest: () => lastPlatformMCPRequest,
    lastPlatformCloudRequest: () => lastPlatformCloudRequest,
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

test("jump-to-latest appears when timeline grows off-bottom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 740 });
  const marker = `JUMP_${Date.now()}`;
  const assistantReply = buildLongAssistantReply(marker);
  const harness = await mockSessionApi(page, assistantReply, marker, {
    jobEventFirstPollDelayMS: 1200,
    assistantDeltaEvents: 8,
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  const largePrompt = Array.from(
    { length: 56 },
    (_, index) => `plan-step-${index + 1} ${marker}`,
  ).join("\n");
  await composer.fill(largePrompt);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const timeline = page.locator(".timeline");
  await expect(page.locator(".message.message-user")).toHaveCount(1);
  await timeline.evaluate((el) => {
    el.style.height = "180px";
    el.style.minHeight = "180px";
    el.style.maxHeight = "180px";
  });
  await expect
    .poll(() =>
      timeline.evaluate((el) => Math.max(0, el.scrollHeight - el.clientHeight)),
    )
    .toBeGreaterThan(20);
  await timeline.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  const jumpButton = page.getByTestId("timeline-jump-latest");
  await expect(jumpButton).toBeVisible({ timeout: 12000 });
  const jumpLabel = (await jumpButton.innerText()).trim().toLowerCase();
  const jumpMatch = jumpLabel.match(/\((\d+)\)/);
  const jumpCount = jumpMatch ? Number.parseInt(jumpMatch[1] ?? "0", 10) : 1;
  expect(Number.isFinite(jumpCount) && jumpCount <= 3).toBeTruthy();
  await jumpButton.click();
  await expect(jumpButton).toHaveCount(0);

  const scrollGap = await timeline.evaluate((el) =>
    Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop),
  );
  expect(scrollGap <= 56).toBeTruthy();
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

test("tree interactions return focus to composer", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `TREE_FOCUS_${Date.now()}`;
  await mockSessionApi(page, `tree focus ${marker}`, marker, {
    includeSecondSession: true,
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await composer.focus();
  await expect(composer).toBeFocused();

  const sessionTwo = page.locator(
    '.session-chip-tree[data-session-id="session_cli_2"]',
  );
  await sessionTwo.click();
  await expect(composer).toBeFocused();

  const projectChip = page.locator(".project-chip").first();
  await projectChip.click();
  await expect(composer).toBeFocused();

  await page.keyboard.type("focus returned");
  await expect(composer).toHaveValue("focus returned");
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

test("ops codex platform auth panel runs status action", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PLATFORM_AUTH_${Date.now()}`;
  const harness = await mockSessionApi(page, `platform auth ${marker}`, marker);
  await unlock(page);

  await page.getByRole("button", { name: "Ops", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Codex Platform" })).toBeVisible();

  await page.getByTestId("platform-login-status-btn").click();
  await expect(page.getByTestId("platform-login-output")).toContainText(
    "Logged in as test-user.",
  );
  await expect.poll(() => {
    const req = harness.lastPlatformLoginRequest();
    return String(req?.action ?? "");
  }).toBe("status");
});

test("ops codex platform mcp/cloud controls map requests", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PLATFORM_REQ_${Date.now()}`;
  const harness = await mockSessionApi(page, `platform req ${marker}`, marker);
  await unlock(page);

  await page.getByRole("button", { name: "Ops", exact: true }).click();

  await page.getByTestId("platform-mcp-action-select").selectOption("add");
  await page.getByTestId("platform-mcp-name-input").fill("memory");
  await page.getByTestId("platform-mcp-command-input").fill("npx @acme/mcp");
  await page.getByTestId("platform-mcp-env-input").fill("TOKEN_ENV=RLM");
  await page.getByTestId("platform-mcp-run-btn").click();
  await expect.poll(() => {
    const req = harness.lastPlatformMCPRequest() as
      | { action?: string; command?: string[]; env?: string[] }
      | null;
    const action = String(req?.action ?? "");
    const command = Array.isArray(req?.command) ? req.command.join(" ") : "";
    const env = Array.isArray(req?.env) ? req.env.join(",") : "";
    return `${action}|${command}|${env}`;
  }).toBe("add|npx @acme/mcp|TOKEN_ENV=RLM");

  await page.getByTestId("platform-cloud-action-select").selectOption("exec");
  await page.getByTestId("platform-cloud-env-id-input").fill("env_staging");
  await page.getByTestId("platform-cloud-query-input").fill("ship release notes");
  await page.getByTestId("platform-cloud-attempts-input").fill("2");
  await page.getByTestId("platform-cloud-branch-input").fill("staging");
  await page.getByTestId("platform-cloud-run-btn").click();
  await expect.poll(() => {
    const req = harness.lastPlatformCloudRequest() as
      | {
          action?: string;
          env_id?: string;
          query?: string;
          attempts?: number;
          branch?: string;
        }
      | null;
    return `${String(req?.action ?? "")}|${String(req?.env_id ?? "")}|${String(req?.query ?? "")}|${String(req?.attempts ?? "")}|${String(req?.branch ?? "")}`;
  }).toBe("exec|env_staging|ship release notes|2|staging");
});

test("advanced codex controls map into run payload", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `ADVANCED_${Date.now()}`;
  const harness = await mockSessionApi(page, `advanced ${marker}`, marker);
  await unlock(page);

  await page.getByTestId("advanced-toggle-btn").click();
  await page.getByTestId("advanced-approval-select").selectOption("never");
  await page.getByTestId("advanced-web-search-toggle").check();
  await page.getByTestId("advanced-profile-input").fill("default");
  await page
    .getByTestId("advanced-config-input")
    .fill("sandbox_workspace_write=true");
  await page.getByTestId("advanced-config-input").press("Enter");
  await page.getByTestId("advanced-enable-input").fill("web_search");
  await page.getByTestId("advanced-enable-input").press("Enter");
  await page.getByTestId("advanced-disable-input").fill("legacy_preview");
  await page.getByTestId("advanced-disable-input").press("Enter");
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
    const req = harness.lastRunRequest() as { approval_policy?: string } | null;
    return String(req?.approval_policy ?? "");
  }).toBe("never");
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { sandbox?: string } | null;
    return String(req?.sandbox ?? "");
  }).toBe("workspace-write");
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { cwd?: string } | null;
    return String(req?.cwd ?? "");
  }).toBe("/srv/work");
  await expect.poll(() => {
    const req = harness.lastRunRequest() as {
      input?: Array<{ type?: string; text?: string }>;
    } | null;
    const first = Array.isArray(req?.input) ? req.input[0] : undefined;
    return `${String(first?.type ?? "")}:${String(first?.text ?? "")}`;
  }).toBe(`text:advanced settings ${marker}`);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { model?: string } | null;
    return String(req?.model ?? "").trim().length > 0;
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { mode?: string } | null;
    return String(req?.mode ?? "");
  }).toBe("exec");
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { search?: boolean } | null;
    return Boolean(req?.search);
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { profile?: string } | null;
    return String(req?.profile ?? "");
  }).toBe("default");
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { config?: string[] } | null;
    return Array.isArray(req?.config) && req.config.includes("sandbox_workspace_write=true");
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { enable?: string[] } | null;
    return Array.isArray(req?.enable) && req.enable.includes("web_search");
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { disable?: string[] } | null;
    return Array.isArray(req?.disable) && req.disable.includes("legacy_preview");
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { add_dirs?: string[] } | null;
    return Array.isArray(req?.add_dirs) && req.add_dirs.includes("/srv/extra");
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { skip_git_repo_check?: boolean } | null;
    return req?.skip_git_repo_check === false;
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { ephemeral?: boolean } | null;
    return Boolean(req?.ephemeral);
  }).toBe(true);
  await expect.poll(() => {
    const req = harness.lastRunRequest() as { json_output?: boolean } | null;
    return Boolean(req?.json_output);
  }).toBe(true);
});

test("composer submits codex exec payload", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `EXEC_MODE_${Date.now()}`;
  const harness = await mockSessionApi(page, `exec ${marker}`, marker);
  await unlock(page);
  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await composer.fill(`exec payload ${marker}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect.poll(() => harness.runRequests()).toBe(1);

  await expect.poll(() => {
    const req = harness.lastRunRequest() as {
      input?: Array<{ type?: string; text?: string }>;
      cwd?: string;
      mode?: string;
    } | null;
    const first = Array.isArray(req?.input) ? req.input[0] : undefined;
    return `${String(first?.type ?? "")}:${String(first?.text ?? "")}|${String(req?.cwd ?? "")}|${String(req?.mode ?? "")}`;
  }).toBe(`text:exec payload ${marker}|/srv/work|exec`);
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
  await expect(
    page.locator(".project-session-list .session-chip-tree", {
      hasText: /Fork · Session 1/,
    }),
  ).toHaveCount(1);
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
  await expect(page.getByText("Response Started")).toHaveCount(0);
  await expect(page.getByText("Server Completed")).toHaveCount(0);
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
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
    timeout: 12000,
  });
  await composer.fill(`regen after stop ${marker}`);
  await composer.press("Enter");
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
  await expect(page.getByText("Response Started")).toHaveCount(0);
  await expect(page.getByText("Server Completed")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(
    page.locator(".message.message-assistant pre", { hasText: marker }),
  ).toHaveCount(1);
  await expect(page.getByText("Response Started")).toHaveCount(0);
  await expect(page.getByText("Server Completed")).toHaveCount(0);
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
    .getByPlaceholder("/path/to/project")
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

test("archiving an empty project removes it from the project list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PROJECT_ARCHIVE_${Date.now()}`;
  await mockSessionApi(page, `project archive ${marker}`, marker);
  await unlock(page);

  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("/path/to/project").fill("/srv/archive-demo");
  await page.getByPlaceholder("My Project").fill("Archive Demo");
  await page.getByRole("button", { name: "Create" }).click();

  const archiveDemoNode = page.locator(".project-node", {
    has: page.locator(".project-chip-main strong", { hasText: "Archive Demo" }),
  }).first();
  await expect(archiveDemoNode).toBeVisible();

  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await archiveDemoNode
    .locator(".project-node-actions .project-archive-btn")
    .nth(1)
    .click();

  await expect(
    page.locator(".project-chip-main strong", { hasText: "Archive Demo" }),
  ).toHaveCount(0);
  await expect(
    page.locator(".project-chip-main strong", { hasText: "work" }),
  ).toBeVisible();
});

test("active project is prioritized to top of project list", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PROJECT_ORDER_${Date.now()}`;
  await mockSessionApi(page, `project order ${marker}`, marker);
  await unlock(page);

  await page.getByRole("button", { name: "New Project" }).click();
  await page
    .getByPlaceholder("/path/to/project")
    .fill("/srv/zzz-project");
  await page.getByPlaceholder("My Project").fill("zzz Project");
  await page.getByRole("button", { name: "Create" }).click();

  const projectTitles = page.locator(".project-chip .project-chip-main strong");
  await expect(projectTitles.first()).toHaveText("zzz Project");

  await page
    .locator(".project-chip", {
      has: page.locator(".project-chip-main strong", { hasText: "work" }),
    })
    .click();
  await expect(projectTitles.first()).toHaveText("work");
});

test("server snapshot prunes stale local project cache on unlock", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `SERVER_TRUTH_${Date.now()}`;
  await mockSessionApi(page, `server truth ${marker}`, marker);
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const staleState = {
      workspaces: [
        {
          id: "project_local_1::/tmp/stale-cache-project",
          hostID: "local_1",
          hostName: "local-default",
          path: "/tmp/stale-cache-project",
          title: "Stale Cache Project",
          sessions: [
            {
              id: "session_stale_cache_1",
              title: "Stale Cache Session",
              draft: "",
              timeline: [],
              createdAt: now,
              updatedAt: now,
            },
          ],
          activeSessionID: "session_stale_cache_1",
          createdAt: now,
          updatedAt: now,
        },
      ],
      activeWorkspaceID: "project_local_1::/tmp/stale-cache-project",
    };
    window.localStorage.setItem(
      "remote_llm_session_state_v1",
      JSON.stringify(staleState),
    );
  });
  await unlock(page);

  await expect(
    page.locator(".project-chip-main strong", { hasText: "work" }),
  ).toBeVisible();
  await expect(
    page.locator(".project-chip-main strong", { hasText: "Stale Cache Project" }),
  ).toHaveCount(0);
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
  const harness = await mockSessionApi(page, `recover ${marker}`, marker, {
    streamPattern: "completion-once",
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

  const composer = page.getByPlaceholder(
    "Tell codex what to do in this workspace...",
  );
  await composer.fill(`recover ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);
  await expect(
    page.locator(".message.message-assistant pre", { hasText: `recover ${marker}` }),
  ).toHaveCount(1, { timeout: 15000 });
  await expect.poll(() => harness.sessionOneStreamAfterValues().length >= 3).toBe(
    true,
  );
  expect(harness.sessionOneStreamAfterValues().slice(0, 3)).toEqual([0, 0, 0]);

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
