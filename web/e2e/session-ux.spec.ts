import { expect, test, type Page } from "@playwright/test";
import { parseCodexAssistantTextFromStdout } from "../src/features/session/codex-parsing";
import { normalizeSessionEvent } from "../src/features/session/session-events";

type MockHarness = {
  runRequests: () => number;
  sessionOneStreamAfterValues: () => number[];
  sessionOneSSECalls: () => number;
  imageUploads: () => number;
  lastRunRequest: () => Record<string, unknown> | null;
  lastReviewStartRequest: () => Record<string, unknown> | null;
  lastProjectGitActionRequest: () => {
    action: string;
    body: Record<string, unknown> | null;
  } | null;
  lastPendingResolveRequest: () => Record<string, unknown> | null;
  lastPlatformLoginRequest: () => Record<string, unknown> | null;
  lastPlatformMCPRequest: () => Record<string, unknown> | null;
  lastPlatformCloudRequest: () => Record<string, unknown> | null;
};

type MockOptions = {
  streamPattern?: "ready-only" | "completion-once";
  pendingRequestScenario?: "command-approval";
  includeSecondSession?: boolean;
  backgroundCompletion?: boolean;
  backgroundCompletionDelayMS?: number;
  titleUpdate?: string;
  jobRunningPolls?: number;
  jobEventFirstPollDelayMS?: number;
  streamFailAttempts?: number;
  runtimeCommandEvents?: boolean;
  runtimeFileChangeEvents?: boolean;
  protocolDiffEvents?: boolean;
  protocolTerminalEvents?: boolean;
  assistantDeltaEvents?: number;
  ignoreStreamAfterCursor?: boolean;
};

type MockSession = {
  id: string;
  project_id: string;
  title: string;
  updated_at: string;
  created_at: string;
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
  let lastReviewStartRequest: Record<string, unknown> | null = null;
  let lastProjectGitActionRequest: {
    action: string;
    body: Record<string, unknown> | null;
  } | null = null;
  let lastPendingResolveRequest: Record<string, unknown> | null = null;
  let lastPlatformLoginRequest: Record<string, unknown> | null = null;
  let lastPlatformMCPRequest: Record<string, unknown> | null = null;
  let lastPlatformCloudRequest: Record<string, unknown> | null = null;

  const streamPattern = options?.streamPattern ?? "ready-only";
  const pendingRequestScenario = options?.pendingRequestScenario ?? null;
  const includeSecondSession = options?.includeSecondSession ?? false;
  const backgroundCompletion = options?.backgroundCompletion ?? false;
  const backgroundCompletionDelayMS = Math.max(
    0,
    options?.backgroundCompletionDelayMS ?? 0,
  );
  const titleUpdate = options?.titleUpdate?.trim() ?? "";
  const jobRunningPolls = Math.max(1, options?.jobRunningPolls ?? 1);
  const jobEventFirstPollDelayMS = Math.max(
    0,
    options?.jobEventFirstPollDelayMS ?? 0,
  );
  const streamFailAttempts = Math.max(0, options?.streamFailAttempts ?? 0);
  const runtimeCommandEvents = options?.runtimeCommandEvents ?? false;
  const runtimeFileChangeEvents = options?.runtimeFileChangeEvents ?? false;
  const protocolDiffEvents = options?.protocolDiffEvents ?? false;
  const protocolTerminalEvents = options?.protocolTerminalEvents ?? false;
  const assistantDeltaEvents = Math.max(1, options?.assistantDeltaEvents ?? 1);
  const ignoreStreamAfterCursor = options?.ignoreStreamAfterCursor ?? false;

  const appDiffText = [
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,4 +1,4 @@",
    " export function App() {",
    '-  return "legacy shell";',
    '+  return "native workbench";',
    " }",
  ].join("\n");
  const docsDiffText = [
    "--- /dev/null",
    "+++ b/docs/review-plan.md",
    "@@ -0,0 +1,3 @@",
    "+# Review plan",
    "+- move shell chrome out of the conversation",
    "+- keep diffs in the review pane",
  ].join("\n");
  const defaultGitChangedPaths =
    runtimeFileChangeEvents || protocolDiffEvents
      ? ["docs/review-plan.md", "src/app.ts"]
      : [];
  const projectGitChangedPaths = new Set<string>(defaultGitChangedPaths);
  const projectGitStagedPaths = new Set<string>();

  let sessionOneStreamAttempts = 0;
  let sessionOneSSECalls = 0;
  let firstTurnDelayApplied = false;
  let backgroundCompletionEmitted = false;
  let sessionStartCounter = 0;
  let forkCounter = 0;
  const sessionOneStreamAfterValues: number[] = [];

  const nowISO = new Date().toISOString();
  const sessions: MockSession[] = [
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
  const archivedSessions: MockSession[] = [];

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

  const sessionRecord = (sessionItem: MockSession) => {
    const project =
      projectRecords.find((item) => item.id === sessionItem.project_id) ??
      projectRecords[0];
    return {
      id: sessionItem.id,
      project_id: sessionItem.project_id,
      host_id: "local_1",
      path: project?.path ?? "/srv/work",
      runtime: "codex",
      title: sessionItem.title,
      created_at: sessionItem.created_at,
      updated_at: sessionItem.updated_at,
    };
  };

  type TurnState = {
    runID: string;
    sessionID: string;
    phase: "pending" | "waiting-request" | "started" | "completed" | "canceled";
    remainingPolls: number;
    pendingRequestID: string;
  };

  const turnStates: TurnState[] = [];
  const sessionEvents = new Map<string, Array<Record<string, unknown>>>();
  const sessionSeq = new Map<string, number>();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const ensureSessionEvents = (
    sessionID: string,
  ): Array<Record<string, unknown>> => {
    let events = sessionEvents.get(sessionID);
    if (!events) {
      events = [];
      sessionEvents.set(sessionID, events);
    }
    return events;
  };

  const nextSessionSeq = (sessionID: string): number => {
    const next = (sessionSeq.get(sessionID) ?? 0) + 1;
    sessionSeq.set(sessionID, next);
    return next;
  };

  const pushSessionEvent = (
    sessionID: string,
    runID: string,
    type: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ) => {
    ensureSessionEvents(sessionID).push({
      seq: nextSessionSeq(sessionID),
      session_id: sessionID,
      run_id: runID,
      type,
      payload,
      created_at: createdAt,
    });
  };

  const pendingRequestRecordForTurn = (
    turnState: TurnState,
  ): Record<string, unknown> | null => {
    if (pendingRequestScenario !== "command-approval") return null;
    if (!turnState.pendingRequestID.trim()) return null;
    return {
      session_id: "session_cli_1",
      request_id: turnState.pendingRequestID,
      host_id: "local_1",
      method: "item/commandExecution/requestApproval",
      received_at: new Date().toISOString(),
      params: {
        threadId: "session_cli_1",
        turnId: turnState.runID,
        itemId: `cmd_${turnState.runID}`,
        command: "git status --short",
        cwd: "/srv/work",
        reason: "Codex needs repo status before it can continue.",
        availableDecisions: ["accept", "decline", "cancel"],
      },
    };
  };

  const buildProjectGitStatusPayload = () => {
    const changedPaths = Array.from(projectGitChangedPaths).sort();
    const stagedPaths = Array.from(projectGitStagedPaths).sort();
    return {
      project_id: "project_local_1__srv_work",
      host_id: "local_1",
      files: changedPaths.map((path) => ({
        path,
        code: projectGitStagedPaths.has(path) ? "M " : " M",
        staged: projectGitStagedPaths.has(path),
        changed: true,
      })),
      changed_paths: changedPaths,
      staged_paths: stagedPaths,
    };
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
              process_id: "pty_cmd_1",
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
              process_id: "pty_cmd_1",
              aggregated_output: "README.md",
              exit_code: 0,
              status: "completed",
            },
          }),
        );
      }
      if (runtimeFileChangeEvents) {
        chunkLines.push(
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "item_patch_1",
              type: "file_change",
              status: "completed",
              changes: [
                {
                  kind: "update",
                  path: "src/app.ts",
                  diff: appDiffText,
                },
                {
                  kind: "create",
                  path: "docs/review-plan.md",
                  diff: docsDiffText,
                },
              ],
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
    pushSessionEvent(
      turnState.sessionID,
      turnState.runID,
      "run.started",
      { turn_id: turnState.runID },
      startedAt,
    );
    pushSessionEvent(
      turnState.sessionID,
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
      pushSessionEvent(
        turnState.sessionID,
        turnState.runID,
        "assistant.delta",
        { chunk: chunkFromText(text, index === 0) },
        startedAt,
      );
    }

    if (protocolDiffEvents) {
      pushSessionEvent(
        turnState.sessionID,
        turnState.runID,
        "codexrpc.turn.diff.updated",
        {
          method: "turn/diff/updated",
          params: {
            threadId: turnState.sessionID,
            turnId: turnState.runID,
            diff: [appDiffText, "", docsDiffText].join("\n"),
          },
        },
        startedAt,
      );
      pushSessionEvent(
        turnState.sessionID,
        turnState.runID,
        "codexrpc.item.filechange.outputdelta",
        {
          method: "item/fileChange/outputDelta",
          params: {
            threadId: turnState.sessionID,
            turnId: turnState.runID,
            itemId: "item_patch_1",
            delta: "@@ streaming patch output @@\n+native workbench\n",
          },
        },
        startedAt,
      );
    }

    if (protocolTerminalEvents) {
      pushSessionEvent(
        turnState.sessionID,
        turnState.runID,
        "codexrpc.item.commandexecution.outputdelta",
        {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: turnState.sessionID,
            turnId: turnState.runID,
            itemId: "item_cmd_1",
            delta: "total 4\n-rw-r--r-- README.md\n",
          },
        },
        startedAt,
      );
      pushSessionEvent(
        turnState.sessionID,
        turnState.runID,
        "codexrpc.item.commandexecution.terminalinteraction",
        {
          method: "item/commandExecution/terminalInteraction",
          params: {
            threadId: turnState.sessionID,
            turnId: turnState.runID,
            itemId: "item_cmd_1",
            processId: "pty_cmd_1",
            stdin: "q\n",
          },
        },
        startedAt,
      );
    }
  };

  const appendTurnTerminalEvents = (turnState: TurnState) => {
    const finishedAt = new Date().toISOString();
    pushSessionEvent(
      turnState.sessionID,
      turnState.runID,
      "target.done",
      {
        host_name: "local-default",
        status: "ok",
        exit_code: 0,
      },
      finishedAt,
    );
    pushSessionEvent(
      turnState.sessionID,
      turnState.runID,
      "assistant.completed",
      { turn_id: turnState.runID },
      finishedAt,
    );
    if (titleUpdate) {
      pushSessionEvent(
        turnState.sessionID,
        turnState.runID,
        "session.title.updated",
        { title: titleUpdate },
        finishedAt,
      );
    }
    pushSessionEvent(
      turnState.sessionID,
      turnState.runID,
      "run.completed",
      { turn_id: turnState.runID },
      finishedAt,
    );
  };

  const materializeSessionEventsForStream = async (sessionID: string) => {
    if (streamPattern !== "completion-once" && streamPattern !== "ready-only") {
      return;
    }
    const current = turnStates.find(
      (state) =>
        state.sessionID === sessionID &&
        (state.phase === "pending" ||
          state.phase === "waiting-request" ||
          state.phase === "started"),
    );
    if (!current) return;

    if (current.phase === "pending") {
      if (!firstTurnDelayApplied && jobEventFirstPollDelayMS > 0) {
        firstTurnDelayApplied = true;
        await sleep(jobEventFirstPollDelayMS);
      }
      appendTurnStartEvents(current);
      current.phase = current.pendingRequestID ? "waiting-request" : "started";
    }

    if (current.phase === "waiting-request") {
      return;
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

  const ensureSessionTwoBackgroundCompletion = async () => {
    if (
      !includeSecondSession ||
      !backgroundCompletion ||
      backgroundCompletionEmitted
    ) {
      return;
    }
    if (backgroundCompletionDelayMS > 0) {
      await sleep(backgroundCompletionDelayMS);
    }
    backgroundCompletionEmitted = true;
    const runID = "turn_bg_1";
    const startedAt = new Date(Date.now() - 1400).toISOString();
    const finishedAt = new Date().toISOString();
    const streamChunk =
      '{"type":"thread.started","thread_id":"t_bg"}\n' +
      '{"type":"turn.started"}\n' +
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `background reply ${marker}` } })}\n`;

    pushSessionEvent(
      "session_cli_2",
      runID,
      "run.started",
      { turn_id: runID },
      startedAt,
    );
    pushSessionEvent(
      "session_cli_2",
      runID,
      "assistant.delta",
      { chunk: streamChunk },
      startedAt,
    );
    pushSessionEvent(
      "session_cli_2",
      runID,
      "assistant.completed",
      { turn_id: runID },
      finishedAt,
    );
    pushSessionEvent(
      "session_cli_2",
      runID,
      "run.completed",
      { turn_id: runID },
      finishedAt,
    );
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
      const existing =
        existingIndex >= 0 ? projectRecords[existingIndex] : null;
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
      const projectID = decodeURIComponent(
        parts[parts.length - 1] ?? "",
      ).trim();
      if (!projectID) {
        await route.fulfill({
          status: 400,
          json: { error: "missing project id" },
        });
        return;
      }
      const existingIndex = projectRecords.findIndex(
        (item) => item.id === projectID,
      );
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
        sessions: filteredSessions.map((sessionItem) =>
          sessionRecord(sessionItem),
        ),
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
            sessions: sessions.map((sessionItem) => {
              const project =
                projectRecords.find(
                  (item) => item.id === sessionItem.project_id,
                ) ?? projectRecords[0];
              return {
                session_id: sessionItem.id,
                thread_name: sessionItem.title,
                cwd: project?.path ?? "/srv/work",
                path: `/home/ecs-user/.codex/sessions/${sessionItem.id}.jsonl`,
                updated_at: sessionItem.updated_at,
                size_bytes: 128,
              };
            }),
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
      (state) =>
        state.phase === "pending" ||
        state.phase === "waiting-request" ||
        state.phase === "started",
    );
    const latestTurn =
      turnStates.length > 0 ? turnStates[turnStates.length - 1] : null;
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
    ensureSessionEvents(sessionID);
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
        session: sessionRecord({
          id: sessionID,
          project_id: project.id,
          title,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
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
        session: sessionRecord({
          id: sessionID,
          project_id: project.id,
          title,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
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
    if (deleted) {
      archivedSessions.push({
        ...deleted,
        updated_at: new Date().toISOString(),
      });
    }
    await route.fulfill({
      status: 200,
      json: {
        archived: true,
        deleted: Boolean(deleted),
        session: deleted ? sessionRecord(deleted) : undefined,
      },
    });
  });

  await page.route(
    "**/v2/codex/sessions/*/unarchive",
    async (route, request) => {
      if (request.method() !== "POST") {
        await route.fallback();
        return;
      }
      const url = new URL(request.url());
      const parts = url.pathname.split("/");
      const sessionID = decodeURIComponent(parts[4] ?? "").trim();
      const archivedIndex = archivedSessions.findIndex(
        (item) => item.id === sessionID,
      );
      const restored =
        archivedIndex >= 0
          ? archivedSessions.splice(archivedIndex, 1)[0]
          : null;
      if (restored) {
        sessions.push({
          ...restored,
          updated_at: new Date().toISOString(),
        });
      }
      const current =
        restored ?? sessions.find((item) => item.id === sessionID) ?? null;
      const project = current
        ? (projectRecords.find((item) => item.id === current.project_id) ??
          projectRecords[0])
        : projectRecords[0];
      await route.fulfill({
        status: current ? 200 : 404,
        json: current
          ? {
              restored: true,
              session: sessionRecord(current),
              project,
              thread: {
                id: current.id,
                preview: current.title,
              },
            }
          : { error: "session not found" },
      });
    },
  );

  await page.route(
    "**/v2/codex/sessions/*/requests/pending",
    async (route, request) => {
      if (request.method() !== "GET") {
        await route.fallback();
        return;
      }
      const url = new URL(request.url());
      const parts = url.pathname.split("/");
      const sessionID = decodeURIComponent(parts[4] ?? "").trim();
      const pending = turnStates
        .filter(
          (state) =>
            state.phase === "waiting-request" &&
            state.pendingRequestID.trim() !== "" &&
            sessionID === "session_cli_1",
        )
        .map((state) => pendingRequestRecordForTurn(state))
        .filter((item): item is Record<string, unknown> => item !== null);
      await route.fulfill({
        status: 200,
        json: {
          session_id: sessionID,
          requests: pending,
        },
      });
    },
  );

  await page.route(
    "**/v2/codex/sessions/*/requests/*/resolve",
    async (route, request) => {
      if (request.method() !== "POST") {
        await route.fallback();
        return;
      }
      const url = new URL(request.url());
      const parts = url.pathname.split("/");
      const sessionID = decodeURIComponent(parts[4] ?? "").trim();
      const requestID = decodeURIComponent(parts[6] ?? "").trim();
      try {
        lastPendingResolveRequest = JSON.parse(
          request.postData() ?? "{}",
        ) as Record<string, unknown>;
      } catch {
        lastPendingResolveRequest = null;
      }
      const turnState = turnStates.find(
        (state) => state.pendingRequestID === requestID,
      );
      if (turnState && turnState.phase === "waiting-request") {
        turnState.phase = "started";
        turnState.pendingRequestID = "";
        turnState.remainingPolls = Math.max(1, turnState.remainingPolls);
      }
      await route.fulfill({
        status: 200,
        json: {
          resolved: true,
          session_id: sessionID,
          request_id: requestID,
        },
      });
    },
  );

  await page.route(
    "**/v2/codex/sessions/*/turns/start",
    async (route, request) => {
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
        sessionID,
        phase: "pending",
        remainingPolls: jobRunningPolls,
        pendingRequestID:
          sessionID === "session_cli_1" && pendingRequestScenario
            ? `req_${runID}`
            : "",
      });

      await route.fulfill({
        status: 200,
        json: {
          turn_id: runID,
          turn: { id: runID },
        },
      });
    },
  );

  await page.route(
    "**/v2/codex/sessions/*/review/start",
    async (route, request) => {
      if (request.method() !== "POST") {
        await route.fallback();
        return;
      }
      const url = new URL(request.url());
      const parts = url.pathname.split("/");
      const sessionID = decodeURIComponent(parts[4] ?? "").trim();

      try {
        lastReviewStartRequest = JSON.parse(
          request.postData() ?? "{}",
        ) as Record<string, unknown>;
      } catch {
        lastReviewStartRequest = null;
      }

      const runID = `review_turn_${runReqCount + 1}`;
      turnStates.push({
        runID,
        sessionID,
        phase: "pending",
        remainingPolls: jobRunningPolls,
        pendingRequestID: "",
      });

      await route.fulfill({
        status: 200,
        json: {
          session: sessionRecord(
            sessions.find((item) => item.id === sessionID) ?? sessions[0],
          ),
          project: projectRecords[0],
          review_thread_id: sessionID,
          turn: { id: runID },
          delivery: "inline",
          target: lastReviewStartRequest
            ? {
                type: (lastReviewStartRequest.review_base as string | undefined)
                  ? "baseBranch"
                  : (lastReviewStartRequest.review_commit as string | undefined)
                    ? "commit"
                    : lastReviewStartRequest.review_uncommitted
                      ? "uncommittedChanges"
                      : "custom",
              }
            : { type: "custom" },
        },
      });
    },
  );

  await page.route("**/v2/projects/*/git/status", async (route, request) => {
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      json: buildProjectGitStatusPayload(),
    });
  });

  await page.route("**/v2/projects/*/git/stage", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    } catch {
      body = null;
    }
    lastProjectGitActionRequest = { action: "stage", body };
    const paths = Array.isArray(body?.paths)
      ? body.paths.map((item) => String(item))
      : [];
    for (const path of paths) {
      if (projectGitChangedPaths.has(path)) {
        projectGitStagedPaths.add(path);
      }
    }
    await route.fulfill({
      status: 200,
      json: {
        action: "stage",
        paths,
        result: { command: `git add -- ${paths.join(" ")}`, exit_code: 0 },
        status: buildProjectGitStatusPayload(),
      },
    });
  });

  await page.route("**/v2/projects/*/git/revert", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    } catch {
      body = null;
    }
    lastProjectGitActionRequest = { action: "revert", body };
    const paths = Array.isArray(body?.paths)
      ? body.paths.map((item) => String(item))
      : [];
    for (const path of paths) {
      projectGitChangedPaths.delete(path);
      projectGitStagedPaths.delete(path);
    }
    await route.fulfill({
      status: 200,
      json: {
        action: "revert",
        paths,
        result: { command: `git restore -- ${paths.join(" ")}`, exit_code: 0 },
        status: buildProjectGitStatusPayload(),
      },
    });
  });

  await page.route("**/v2/projects/*/git/commit", async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    } catch {
      body = null;
    }
    lastProjectGitActionRequest = { action: "commit", body };
    for (const path of Array.from(projectGitStagedPaths)) {
      projectGitChangedPaths.delete(path);
      projectGitStagedPaths.delete(path);
    }
    await route.fulfill({
      status: 200,
      json: {
        action: "commit",
        message: String(body?.message ?? ""),
        result: { command: "git commit -m ...", exit_code: 0 },
        status: buildProjectGitStatusPayload(),
      },
    });
  });

  await page.route(
    "**/v2/codex/sessions/*/turns/*/interrupt",
    async (route, request) => {
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
        pushSessionEvent(
          state.sessionID,
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
    },
  );

  await page.route("**/v2/codex/sessions/*/stream**", async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split("/");
    const sessionID = decodeURIComponent(parts[4] ?? "").trim();
    const streamAfterRaw = url.searchParams.get("after") ?? "0";
    const streamAfter = Number.parseInt(streamAfterRaw, 10);
    const safeStreamAfter =
      Number.isFinite(streamAfter) && streamAfter > 0 ? streamAfter : 0;

    if (sessionID === "session_cli_1") {
      sessionOneSSECalls += 1;
      sessionOneStreamAfterValues.push(safeStreamAfter);
      if (sessionOneStreamAttempts < streamFailAttempts) {
        sessionOneStreamAttempts += 1;
        await route.fulfill({
          status: 503,
          body: "stream temporarily unavailable",
        });
        return;
      }
      await materializeSessionEventsForStream(sessionID);
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: buildSSEBody(
          sessionID,
          ignoreStreamAfterCursor ? 0 : safeStreamAfter,
          ensureSessionEvents(sessionID),
        ),
      });
      return;
    }

    if (sessionID === "session_cli_2") {
      await ensureSessionTwoBackgroundCompletion();
      await materializeSessionEventsForStream(sessionID);
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: buildSSEBody(
          sessionID,
          safeStreamAfter,
          ensureSessionEvents(sessionID),
        ),
      });
      return;
    }

    await materializeSessionEventsForStream(sessionID);

    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: buildSSEBody(
        sessionID,
        safeStreamAfter,
        ensureSessionEvents(sessionID),
      ),
    });
  });

  return {
    runRequests: () => runReqCount,
    sessionOneStreamAfterValues: () => [...sessionOneStreamAfterValues],
    sessionOneSSECalls: () => sessionOneSSECalls,
    imageUploads: () => imageUploadCount,
    lastRunRequest: () => lastRunRequest,
    lastReviewStartRequest: () => lastReviewStartRequest,
    lastProjectGitActionRequest: () => lastProjectGitActionRequest,
    lastPendingResolveRequest: () => lastPendingResolveRequest,
    lastPlatformLoginRequest: () => lastPlatformLoginRequest,
    lastPlatformMCPRequest: () => lastPlatformMCPRequest,
    lastPlatformCloudRequest: () => lastPlatformCloudRequest,
  };
}

async function installMockSessionWebSocket(
  page: Page,
  opts: {
    sessionID: string;
    marker: string;
    mode?: "replay-once" | "reset-reconnect" | "flaky-reset-reconnect";
  },
): Promise<void> {
  await page.addInitScript(
    (config: {
      sessionID: string;
      marker: string;
      mode?: "replay-once" | "reset-reconnect" | "flaky-reset-reconnect";
    }) => {
      const globalAny = window as unknown as {
        __mockWsState?: { calls: Array<{ sessionID: string; after: number }> };
        __mockWsControl?: {
          triggerResetReconnect?: () => void;
          triggerFlakyResetReconnect?: () => void;
        };
        WebSocket: typeof WebSocket;
      };
      const mode = config.mode ?? "replay-once";
      const emitted = new Set<string>();
      const nowISO = () => new Date().toISOString();
      const activeSockets = new Set<SessionMockWebSocket>();
      const resetState: { phase: "idle" | "await_reconnect" | "done" } = {
        phase: "idle",
      };
      const flakyResetState: {
        phase: "idle" | "await_reconnect_1" | "await_reconnect_2" | "done";
      } = {
        phase: "idle",
      };

      class SessionMockWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        url: string;
        readyState = SessionMockWebSocket.CONNECTING;
        bufferedAmount = 0;
        extensions = "";
        protocol = "";
        binaryType: BinaryType = "blob";
        onopen: ((ev: Event) => void) | null = null;
        onclose: ((ev: CloseEvent) => void) | null = null;
        onerror: ((ev: Event) => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        sessionID = "";
        after = 0;

        constructor(url: string | URL) {
          this.url = typeof url === "string" ? url : String(url);
          if (!globalAny.__mockWsState) {
            globalAny.__mockWsState = { calls: [] };
          }
          const parsed = new URL(this.url, window.location.href);
          const parts = parsed.pathname.split("/");
          const sessionID = decodeURIComponent(parts[4] ?? "").trim();
          const rawAfter = parsed.searchParams.get("after") ?? "0";
          const after = Number.parseInt(rawAfter, 10);
          const safeAfter = Number.isFinite(after) && after > 0 ? after : 0;
          this.sessionID = sessionID;
          this.after = safeAfter;
          globalAny.__mockWsState.calls.push({ sessionID, after: safeAfter });

          window.setTimeout(() => {
            if (this.readyState !== SessionMockWebSocket.CONNECTING) return;
            this.readyState = SessionMockWebSocket.OPEN;
            activeSockets.add(this);
            this.onopen?.(new Event("open"));

            const readyCursor = safeAfter;
            if (mode === "reset-reconnect") {
              if (
                sessionID === config.sessionID &&
                resetState.phase === "await_reconnect" &&
                safeAfter > 0
              ) {
                const runID = "turn_1";
                const chunk =
                  '{"type":"thread.started","thread_id":"ws_reset"}\n' +
                  '{"type":"turn.started"}\n' +
                  JSON.stringify({
                    type: "item.completed",
                    item: {
                      type: "agent_message",
                      text: `ws reset replay ${config.marker}`,
                    },
                  }) +
                  "\n";
                const frames: Array<Record<string, unknown>> = [
                  {
                    type: "session.event",
                    id: "3",
                    event: {
                      seq: 3,
                      session_id: config.sessionID,
                      run_id: runID,
                      type: "assistant.delta",
                      payload: { chunk },
                      created_at: nowISO(),
                    },
                  },
                  {
                    type: "session.event",
                    id: "4",
                    event: {
                      seq: 4,
                      session_id: config.sessionID,
                      run_id: runID,
                      type: "assistant.completed",
                      payload: { turn_id: runID },
                      created_at: nowISO(),
                    },
                  },
                  {
                    type: "session.event",
                    id: "5",
                    event: {
                      seq: 5,
                      session_id: config.sessionID,
                      run_id: runID,
                      type: "run.completed",
                      payload: { turn_id: runID },
                      created_at: nowISO(),
                    },
                  },
                  {
                    type: "session.ready",
                    session_id: config.sessionID,
                    cursor: 5,
                  },
                ];
                resetState.phase = "done";
                this.pump(frames);
                return;
              }
              this.emit({
                type: "session.ready",
                session_id: sessionID,
                cursor: readyCursor,
              });
              return;
            }
            if (mode === "flaky-reset-reconnect") {
              if (
                sessionID === config.sessionID &&
                flakyResetState.phase === "await_reconnect_1" &&
                safeAfter >= 2
              ) {
                const runID = "turn_1";
                const chunk =
                  '{"type":"thread.started","thread_id":"ws_flaky"}\n' +
                  '{"type":"turn.started"}\n' +
                  JSON.stringify({
                    type: "item.completed",
                    item: {
                      type: "agent_message",
                      text: `ws flaky reset mid ${config.marker}`,
                    },
                  }) +
                  "\n";
                flakyResetState.phase = "await_reconnect_2";
                this.emit({
                  type: "session.event",
                  id: "3",
                  event: {
                    seq: 3,
                    session_id: config.sessionID,
                    run_id: runID,
                    type: "assistant.delta",
                    payload: { chunk },
                    created_at: nowISO(),
                  },
                });
                this.emit({
                  type: "session.reset",
                  session_id: config.sessionID,
                  reason: "backpressure",
                  next_after: 3,
                });
                window.setTimeout(() => this.close(1012, "mock-reset-2"), 0);
                return;
              }
              if (
                sessionID === config.sessionID &&
                flakyResetState.phase === "await_reconnect_2" &&
                safeAfter >= 3
              ) {
                const runID = "turn_1";
                flakyResetState.phase = "done";
                const frames: Array<Record<string, unknown>> = [
                  {
                    type: "session.event",
                    id: "4",
                    event: {
                      seq: 4,
                      session_id: config.sessionID,
                      run_id: runID,
                      type: "assistant.completed",
                      payload: { turn_id: runID },
                      created_at: nowISO(),
                    },
                  },
                  {
                    type: "session.event",
                    id: "5",
                    event: {
                      seq: 5,
                      session_id: config.sessionID,
                      run_id: runID,
                      type: "run.completed",
                      payload: { turn_id: runID },
                      created_at: nowISO(),
                    },
                  },
                  {
                    type: "session.ready",
                    session_id: config.sessionID,
                    cursor: 5,
                  },
                ];
                this.pump(frames);
                return;
              }
              this.emit({
                type: "session.ready",
                session_id: sessionID,
                cursor: readyCursor,
              });
              return;
            }

            const shouldReplay =
              sessionID === config.sessionID &&
              safeAfter <= 0 &&
              !emitted.has(sessionID);
            if (shouldReplay) {
              emitted.add(sessionID);
              const runID = "turn_ws_mock_1";
              const chunk =
                '{"type":"thread.started","thread_id":"ws_mock"}\n' +
                '{"type":"turn.started"}\n' +
                JSON.stringify({
                  type: "item.completed",
                  item: {
                    type: "agent_message",
                    text: `ws replay ${config.marker}`,
                  },
                }) +
                "\n";
              const frames: Array<Record<string, unknown>> = [
                {
                  type: "session.event",
                  id: "1",
                  event: {
                    seq: 1,
                    session_id: config.sessionID,
                    run_id: runID,
                    type: "run.started",
                    payload: { turn_id: runID },
                    created_at: nowISO(),
                  },
                },
                {
                  type: "session.event",
                  id: "2",
                  event: {
                    seq: 2,
                    session_id: config.sessionID,
                    run_id: runID,
                    type: "assistant.delta",
                    payload: { chunk },
                    created_at: nowISO(),
                  },
                },
                {
                  type: "session.event",
                  id: "3",
                  event: {
                    seq: 3,
                    session_id: config.sessionID,
                    run_id: runID,
                    type: "assistant.completed",
                    payload: { turn_id: runID },
                    created_at: nowISO(),
                  },
                },
                {
                  type: "session.event",
                  id: "4",
                  event: {
                    seq: 4,
                    session_id: config.sessionID,
                    run_id: runID,
                    type: "run.completed",
                    payload: { turn_id: runID },
                    created_at: nowISO(),
                  },
                },
                {
                  type: "session.ready",
                  session_id: config.sessionID,
                  cursor: 4,
                },
              ];
              this.pump(frames);
              return;
            }

            this.emit({
              type: "session.ready",
              session_id: sessionID,
              cursor: readyCursor,
            });
          }, 0);
        }

        emit(frame: Record<string, unknown>): void {
          if (this.readyState !== SessionMockWebSocket.OPEN) return;
          this.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(frame) }),
          );
        }

        pump(frames: Array<Record<string, unknown>>): void {
          let index = 0;
          const tick = () => {
            if (index >= frames.length) return;
            this.emit(frames[index] ?? {});
            index += 1;
            if (index < frames.length) {
              window.setTimeout(tick, 8);
            }
          };
          window.setTimeout(tick, 8);
        }

        send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          // no-op for test transport
        }

        close(code?: number, reason?: string): void {
          if (this.readyState === SessionMockWebSocket.CLOSED) return;
          activeSockets.delete(this);
          this.readyState = SessionMockWebSocket.CLOSED;
          this.onclose?.(
            new CloseEvent("close", {
              code: code ?? 1000,
              reason: reason ?? "mock-closed",
              wasClean: true,
            }),
          );
        }

        addEventListener(): void {
          // on* handlers are sufficient for this test path
        }

        removeEventListener(): void {
          // on* handlers are sufficient for this test path
        }

        dispatchEvent(): boolean {
          return true;
        }
      }

      globalAny.__mockWsControl = {
        triggerResetReconnect: () => {
          if (mode !== "reset-reconnect") return;
          if (resetState.phase !== "idle") return;
          resetState.phase = "await_reconnect";
          const runID = "turn_1";
          const chunk =
            '{"type":"thread.started","thread_id":"ws_reset"}\n' +
            '{"type":"turn.started"}\n' +
            JSON.stringify({
              type: "item.completed",
              item: {
                type: "agent_message",
                text: `ws reset ${config.marker}`,
              },
            }) +
            "\n";
          for (const socket of Array.from(activeSockets)) {
            if (socket.sessionID !== config.sessionID) continue;
            socket.emit({
              type: "session.event",
              id: "1",
              event: {
                seq: 1,
                session_id: config.sessionID,
                run_id: runID,
                type: "run.started",
                payload: { turn_id: runID },
                created_at: nowISO(),
              },
            });
            socket.emit({
              type: "session.event",
              id: "2",
              event: {
                seq: 2,
                session_id: config.sessionID,
                run_id: runID,
                type: "assistant.delta",
                payload: { chunk },
                created_at: nowISO(),
              },
            });
            socket.emit({
              type: "session.reset",
              session_id: config.sessionID,
              reason: "backpressure",
              next_after: 2,
            });
            window.setTimeout(() => socket.close(1012, "mock-reset"), 0);
          }
        },
        triggerFlakyResetReconnect: () => {
          if (mode !== "flaky-reset-reconnect") return;
          if (flakyResetState.phase !== "idle") return;
          flakyResetState.phase = "await_reconnect_1";
          const runID = "turn_1";
          const chunk =
            '{"type":"thread.started","thread_id":"ws_flaky"}\n' +
            '{"type":"turn.started"}\n' +
            JSON.stringify({
              type: "item.completed",
              item: {
                type: "agent_message",
                text: `ws flaky reset ${config.marker}`,
              },
            }) +
            "\n";
          for (const socket of Array.from(activeSockets)) {
            if (socket.sessionID !== config.sessionID) continue;
            socket.emit({
              type: "session.event",
              id: "1",
              event: {
                seq: 1,
                session_id: config.sessionID,
                run_id: runID,
                type: "run.started",
                payload: { turn_id: runID },
                created_at: nowISO(),
              },
            });
            socket.emit({
              type: "session.event",
              id: "2",
              event: {
                seq: 2,
                session_id: config.sessionID,
                run_id: runID,
                type: "assistant.delta",
                payload: { chunk },
                created_at: nowISO(),
              },
            });
            socket.emit({
              type: "session.reset",
              session_id: config.sessionID,
              reason: "backpressure",
              next_after: 2,
            });
            window.setTimeout(() => socket.close(1012, "mock-reset-1"), 0);
          }
        },
      };

      // Use mocked WebSocket transport for deterministic stream tests.
      globalAny.WebSocket = SessionMockWebSocket as unknown as typeof WebSocket;
      (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
        SessionMockWebSocket as unknown as typeof WebSocket;
    },
    opts,
  );
}

test("codex parser plain-text fallback strips transport noise lines", async () => {
  const stdout = [
    "Connected. hosts=1 runtimes=3 queue_depth=0",
    "local-default done status=failed exit=1 error=local command failed: exit status 1",
    "local-default failed error=local command failed: exit status 1 hint=inspect stderr",
    "use --skip-git-repo-check next time",
  ].join("\n");
  expect(parseCodexAssistantTextFromStdout(stdout, true)).toBe(
    "use --skip-git-repo-check next time",
  );
});

test("codex parser plain-text fallback returns empty when only noise exists", async () => {
  const stdout = [
    "Connected. hosts=1 runtimes=3 queue_depth=0",
    "local-default done status=failed exit=1 error=local command failed: exit status 1",
    '{"type":"thread.started","thread_id":"abc"}',
    '{"type":"turn.started"}',
    "Done.",
  ].join("\n");
  expect(parseCodexAssistantTextFromStdout(stdout, true)).toBe("");
});

test("normalizeSessionEvent maps codexrpc agent message deltas into assistant stream chunks", async () => {
  const normalized = normalizeSessionEvent({
    seq: 10,
    session_id: "session_live_1",
    run_id: "turn_live_1",
    type: "codexrpc.item.agentMessage.delta",
    payload: {
      host_id: "host_live_1",
      method: "item/agentMessage/delta",
      params: {
        threadId: "session_live_1",
        turnId: "turn_live_1",
        itemId: "msg_live_1",
        delta: "hello live stream",
      },
    },
    created_at: "2026-03-06T15:40:49.373255118Z",
  });

  expect(normalized).not.toBeNull();
  expect(normalized?.eventType).toBe("assistant.delta");

  const chunk = String(normalized?.payload.chunk ?? "");
  expect(chunk).toContain('"type":"item.agent_message.delta"');
  expect(chunk).toContain('"delta":"hello live stream"');
  expect(parseCodexAssistantTextFromStdout(chunk, false)).toBe(
    "hello live stream",
  );
});

test("codex parser preserves whitespace in streaming deltas", async () => {
  const stdout = [
    JSON.stringify({
      type: "item.agent_message.delta",
      delta: "LIVE_LONG line 1\nLIVE_LONG line 2\n",
    }),
    JSON.stringify({
      type: "item.agent_message.delta",
      delta: "LIVE_LONG line 3",
    }),
  ].join("\n");

  expect(parseCodexAssistantTextFromStdout(stdout, false)).toBe(
    "LIVE_LONG line 1\nLIVE_LONG line 2\nLIVE_LONG line 3",
  );
});

test("codex parser ignores terminal and file diff delta payloads", async () => {
  const stdout = [
    JSON.stringify({
      type: "item.commandexecution.outputdelta",
      itemId: "cmd_1",
      delta: "README.md\n",
    }),
    JSON.stringify({
      type: "item.filechange.outputdelta",
      itemId: "patch_1",
      delta: "@@ -1 +1 @@\n",
    }),
  ].join("\n");

  expect(parseCodexAssistantTextFromStdout(stdout, false)).toBe("");
});

test("codex parser accepts camelCase agentMessage final items", async () => {
  const stdout = JSON.stringify({
    type: "item.completed",
    item: {
      type: "agentMessage",
      phase: "final_answer",
      text: "1 LIVE_LONG\n2 LIVE_LONG\n3 LIVE_LONG",
    },
  });

  expect(parseCodexAssistantTextFromStdout(stdout, false)).toBe(
    "1 LIVE_LONG\n2 LIVE_LONG\n3 LIVE_LONG",
  );
});

test("codex parser extracts assistant text from response_item envelopes", async () => {
  const stdout = JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "line-1\nline-2",
        },
      ],
      phase: "final_answer",
    },
  });

  expect(parseCodexAssistantTextFromStdout(stdout, false)).toBe(
    "line-1\nline-2",
  );
});

async function unlock(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("rlm_xxx.yyy").fill("rlm_test.token");
  await page.getByRole("button", { name: "Unlock Codex" }).click();
  await expect(page.locator(".session-side")).toBeVisible();
  await expect(
    page.getByPlaceholder("Search projects or threads"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
}

async function revisitWorkspace(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  const workspaceShell = page.locator(".session-side");
  try {
    await expect(workspaceShell).toBeVisible({ timeout: 15000 });
    return;
  } catch {
    const tokenInput = page.getByPlaceholder("rlm_xxx.yyy");
    await expect(tokenInput).toBeVisible({ timeout: 15000 });
    await tokenInput.fill("rlm_test.token");
    await page.getByRole("button", { name: "Unlock Codex" }).click();
    await expect(workspaceShell).toBeVisible();
  }
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
  await expect(page.locator(".chat-context")).toContainText("/srv/work");
  await expect(page.locator(".pane-summary-copy").first()).toContainText(
    "1 project across 1",
  );
  await expect(
    page.getByText("Servers, project paths, and session history."),
  ).toHaveCount(0);
  const sideBox = await sidebar.boundingBox();
  const chatBox = await chatPane.boundingBox();
  expect(sideBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect(Math.abs((chatBox?.y ?? 0) - (sideBox?.y ?? 0)) <= 40).toBeTruthy();
  expect((chatBox?.width ?? 0) >= 600).toBeTruthy();

  const projectFilter = page.getByPlaceholder("Search projects or threads");
  await expect(projectFilter).toBeVisible();
  await projectFilter.fill("session 1");
  await expect(page.locator(".session-chip-tree")).toHaveCount(1);
  await projectFilter.fill("not-found-session");
  await expect(
    page.getByText("No matching projects or threads."),
  ).toBeVisible();
  await projectFilter.fill("");
  await expect(page.locator(".project-host-pill").first()).toBeVisible();

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
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
  await expect
    .poll(
      () =>
        composer.evaluate((el) =>
          Number.parseFloat(getComputedStyle(el).height),
        ),
      {
        message: "composer textarea should grow for multiline prompts",
      },
    )
    .toBeGreaterThan(initialHeight);

  await composer.fill(`reply once with marker: ${marker}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const assistantWithMarker = page.locator(".message.message-assistant pre", {
    hasText: marker,
  });
  await expect(assistantWithMarker).toHaveCount(1);
  await expect(
    page.locator(".message.message-assistant .message-title-row"),
  ).toHaveCount(0);
  await expect(
    page.locator(".message.message-user .message-title-row"),
  ).toHaveCount(0);
  await expect(
    page.locator(".message.message-assistant .message-meta time"),
  ).toHaveCount(1);
  await expect(
    page.locator(".message.message-user .message-meta time"),
  ).toHaveCount(1);
  await expect(page.getByText(/"type":"thread.started"/)).toHaveCount(0);
  await expect(page.getByText(/^Done\.$/)).toHaveCount(0);

  const timeline = page.locator(".timeline");
  const scrollGap = await timeline.evaluate((el) =>
    Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop),
  );
  expect(scrollGap <= 48).toBeTruthy();
});

test("top shell keeps utilities secondary to the active session workspace", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `SHELL_REDUCTION_${Date.now()}`;
  await mockSessionApi(page, `shell reduction ${marker}`, marker);
  await unlock(page);

  const topbar = page.locator(".app-topbar");
  await expect(topbar.getByRole("button", { name: "Tools", exact: true })).toBeVisible();
  await expect(
    topbar.getByRole("button", { name: "Session", exact: true }),
  ).toHaveCount(0);
  await expect(
    topbar.getByRole("button", { name: "Ops", exact: true }),
  ).toHaveCount(0);
  await expect(
    topbar.getByRole("button", { name: "Refresh", exact: true }),
  ).toHaveCount(0);
  await expect(
    topbar.getByRole("button", { name: "Lock", exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveTitle(/Codex$/);
  await expect(page.getByTestId("stream-status")).toContainText("Live");
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
    "Ask Codex to work in this project...",
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
    "Ask Codex to work in this project...",
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
  await expect(
    page.getByRole("button", { name: /mock-image-01\.png/i }),
  ).toBeVisible();

  await composerPanel.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File(["img-drop"], "drop.png", { type: "image/png" }));
    const dragEnter = new Event("dragenter", {
      bubbles: true,
      cancelable: true,
    });
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
  await expect(
    page.getByRole("button", { name: /mock-image-02\.png/i }),
  ).toBeVisible();
});

test("tree interactions return focus to composer", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `TREE_FOCUS_${Date.now()}`;
  await mockSessionApi(page, `tree focus ${marker}`, marker, {
    includeSecondSession: true,
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
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
  await expect
    .poll(async () => sessionChips.count())
    .toBe(initialSessionCount + 1);
});

test("ops codex platform auth panel runs status action", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PLATFORM_AUTH_${Date.now()}`;
  const harness = await mockSessionApi(page, `platform auth ${marker}`, marker);
  await unlock(page);

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Codex Platform" }),
  ).toBeVisible();

  await page.getByTestId("platform-login-status-btn").click();
  await expect(page.getByTestId("platform-login-output")).toContainText(
    "Logged in as test-user.",
  );
  await expect
    .poll(() => {
      const req = harness.lastPlatformLoginRequest();
      return String(req?.action ?? "");
    })
    .toBe("status");
});

test("ops codex platform mcp/cloud controls map requests", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PLATFORM_REQ_${Date.now()}`;
  const harness = await mockSessionApi(page, `platform req ${marker}`, marker);
  await unlock(page);

  await page.getByRole("button", { name: "Tools", exact: true }).click();

  await page.getByTestId("platform-mcp-action-select").selectOption("add");
  await page.getByTestId("platform-mcp-name-input").fill("memory");
  await page.getByTestId("platform-mcp-command-input").fill("npx @acme/mcp");
  await page.getByTestId("platform-mcp-env-input").fill("TOKEN_ENV=RLM");
  await page.getByTestId("platform-mcp-run-btn").click();
  await expect
    .poll(() => {
      const req = harness.lastPlatformMCPRequest() as {
        action?: string;
        command?: string[];
        env?: string[];
      } | null;
      const action = String(req?.action ?? "");
      const command = Array.isArray(req?.command) ? req.command.join(" ") : "";
      const env = Array.isArray(req?.env) ? req.env.join(",") : "";
      return `${action}|${command}|${env}`;
    })
    .toBe("add|npx @acme/mcp|TOKEN_ENV=RLM");

  await page.getByTestId("platform-cloud-action-select").selectOption("exec");
  await page.getByTestId("platform-cloud-env-id-input").fill("env_staging");
  await page
    .getByTestId("platform-cloud-query-input")
    .fill("ship release notes");
  await page.getByTestId("platform-cloud-attempts-input").fill("2");
  await page.getByTestId("platform-cloud-branch-input").fill("staging");
  await page.getByTestId("platform-cloud-run-btn").click();
  await expect
    .poll(() => {
      const req = harness.lastPlatformCloudRequest() as {
        action?: string;
        env_id?: string;
        query?: string;
        attempts?: number;
        branch?: string;
      } | null;
      return `${String(req?.action ?? "")}|${String(req?.env_id ?? "")}|${String(req?.query ?? "")}|${String(req?.attempts ?? "")}|${String(req?.branch ?? "")}`;
    })
    .toBe("exec|env_staging|ship release notes|2|staging");
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
    "Ask Codex to work in this project...",
  );
  await composer.fill(`advanced settings ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as {
        approval_policy?: string;
      } | null;
      return String(req?.approval_policy ?? "");
    })
    .toBe("never");
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { sandbox?: string } | null;
      return String(req?.sandbox ?? "");
    })
    .toBe("workspace-write");
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { cwd?: string } | null;
      return String(req?.cwd ?? "");
    })
    .toBe("/srv/work");
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as {
        input?: Array<{ type?: string; text?: string }>;
      } | null;
      const first = Array.isArray(req?.input) ? req.input[0] : undefined;
      return `${String(first?.type ?? "")}:${String(first?.text ?? "")}`;
    })
    .toBe(`text:advanced settings ${marker}`);
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { model?: string } | null;
      return String(req?.model ?? "").trim().length > 0;
    })
    .toBe(true);
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { mode?: string } | null;
      return String(req?.mode ?? "");
    })
    .toBe("exec");
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { search?: boolean } | null;
      return Boolean(req?.search);
    })
    .toBe(true);
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { profile?: string } | null;
      return String(req?.profile ?? "");
    })
    .toBe("default");
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { config?: string[] } | null;
      return (
        Array.isArray(req?.config) &&
        req.config.includes("sandbox_workspace_write=true")
      );
    })
    .toBe(true);
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { enable?: string[] } | null;
      return Array.isArray(req?.enable) && req.enable.includes("web_search");
    })
    .toBe(true);
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { disable?: string[] } | null;
      return (
        Array.isArray(req?.disable) && req.disable.includes("legacy_preview")
      );
    })
    .toBe(true);
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { add_dirs?: string[] } | null;
      return (
        Array.isArray(req?.add_dirs) && req.add_dirs.includes("/srv/extra")
      );
    })
    .toBe(true);
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as {
        skip_git_repo_check?: boolean;
      } | null;
      return req?.skip_git_repo_check === false;
    })
    .toBe(true);
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { ephemeral?: boolean } | null;
      return Boolean(req?.ephemeral);
    })
    .toBe(true);
  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as { json_output?: boolean } | null;
      return Boolean(req?.json_output);
    })
    .toBe(true);
});

test("pending command approval can be resolved inline", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PENDING_REQUEST_${Date.now()}`;
  const harness = await mockSessionApi(
    page,
    `pending request ${marker}`,
    marker,
    {
      pendingRequestScenario: "command-approval",
    },
  );
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`pending request ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const pendingCard = page.getByTestId("pending-request-card");
  await expect(pendingCard).toContainText("Approve command");
  await expect(pendingCard).toContainText("git status --short");

  await page.getByTestId("pending-request-decision-accept").click();
  await expect
    .poll(() => {
      const req = harness.lastPendingResolveRequest() as {
        result?: { decision?: string };
      } | null;
      return String(req?.result?.decision ?? "");
    })
    .toBe("accept");
  await expect(page.getByTestId("pending-request-card")).toHaveCount(0);
});

test("composer submits codex exec payload", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `EXEC_MODE_${Date.now()}`;
  const harness = await mockSessionApi(page, `exec ${marker}`, marker);
  await unlock(page);
  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`exec payload ${marker}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect.poll(() => harness.runRequests()).toBe(1);

  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as {
        input?: Array<{ type?: string; text?: string }>;
        cwd?: string;
        mode?: string;
      } | null;
      const first = Array.isArray(req?.input) ? req.input[0] : undefined;
      return `${String(first?.type ?? "")}:${String(first?.text ?? "")}|${String(req?.cwd ?? "")}|${String(req?.mode ?? "")}`;
    })
    .toBe(`text:exec payload ${marker}|/srv/work|exec`);
});

test("review pane stays secondary but drives review payloads", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `REVIEW_MODE_${Date.now()}`;
  const harness = await mockSessionApi(page, `review result ${marker}`, marker);
  await unlock(page);

  await expect(page.getByTestId("review-pane")).toHaveCount(0);
  await page.getByTestId("review-pane-toggle").click();
  await expect(page.getByTestId("review-pane")).toBeVisible();

  await page.keyboard.press("Control+Alt+b");
  await expect(page.getByTestId("review-pane")).toHaveCount(0);
  await page.keyboard.press("Control+Alt+b");
  await expect(page.getByTestId("review-pane")).toBeVisible();

  await page.getByTestId("review-mode-review").click();
  await page.getByTestId("review-uncommitted-toggle").check();
  await page.getByTestId("review-base-input").fill("staging");
  await page.getByTestId("review-commit-input").fill("HEAD~2");
  await page.getByTestId("review-title-input").fill("Native parity review");

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`review payload ${marker}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect.poll(() => harness.runRequests()).toBe(1);

  await expect
    .poll(() => {
      const req = harness.lastRunRequest() as {
        mode?: string;
        review_uncommitted?: boolean;
        review_base?: string;
        review_commit?: string;
        review_title?: string;
      } | null;
      return JSON.stringify({
        mode: req?.mode ?? "",
        review_uncommitted: Boolean(req?.review_uncommitted),
        review_base: req?.review_base ?? "",
        review_commit: req?.review_commit ?? "",
        review_title: req?.review_title ?? "",
      });
    })
    .toBe(
      JSON.stringify({
        mode: "review",
        review_uncommitted: true,
        review_base: "staging",
        review_commit: "HEAD~2",
        review_title: "Native parity review",
      }),
    );

  await expect(page.getByTestId("review-findings")).toContainText(marker);
});

test("review pane starts a dedicated review turn via review/start", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `REVIEW_START_${Date.now()}`;
  const harness = await mockSessionApi(page, `review result ${marker}`, marker);
  await unlock(page);

  await page.getByTestId("review-pane-toggle").click();
  await expect(page.getByTestId("review-pane")).toBeVisible();
  await page.getByTestId("review-mode-review").click();
  await page.getByTestId("review-base-input").fill("main");
  await page.getByTestId("review-title-input").fill("Native review sweep");
  await page.getByTestId("review-start-btn").click();

  await expect.poll(() => harness.runRequests()).toBe(0);
  await expect
    .poll(() => {
      const req = harness.lastReviewStartRequest() as {
        host_id?: string;
        path?: string;
        title?: string;
        review_base?: string;
        review_title?: string;
        delivery?: string;
      } | null;
      return JSON.stringify({
        host_id: req?.host_id ?? "",
        path: req?.path ?? "",
        title: req?.title ?? "",
        review_base: req?.review_base ?? "",
        review_title: req?.review_title ?? "",
        delivery: req?.delivery ?? "",
      });
    })
    .toBe(
      JSON.stringify({
        host_id: "local_1",
        path: "/srv/work",
        title: "Session 1",
        review_base: "main",
        review_title: "Native review sweep",
        delivery: "inline",
      }),
    );
});

test("review pane surfaces changed files away from the main chat flow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `REVIEW_CHANGES_${Date.now()}`;
  const harness = await mockSessionApi(
    page,
    `review changes ${marker}`,
    marker,
    {
      runtimeFileChangeEvents: true,
    },
  );
  await unlock(page);

  await page.getByTestId("review-pane-toggle").click();
  await expect(page.getByTestId("review-pane")).toBeVisible();
  await page.getByTestId("review-mode-review").click();

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`review changed files ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);
  await expect(page.locator(".timeline")).not.toContainText("Patch Applied");

  const changeList = page.getByTestId("review-change-list");
  await expect(changeList).toContainText("src/app.ts");
  await expect(changeList).toContainText("docs/review-plan.md");

  const docsChange = page.getByTestId("review-change-item").filter({
    hasText: "docs/review-plan.md",
  });
  await docsChange.click();
  await expect(page.getByTestId("review-change-detail")).toContainText(
    "docs/review-plan.md",
  );
  await expect(page.getByTestId("review-change-detail")).toContainText(
    "Patch Applied",
  );
  await expect(page.getByTestId("review-change-diff")).toContainText(
    "+++ b/docs/review-plan.md",
  );
  await expect(page.getByTestId("review-change-diff")).toContainText(
    "+# Review plan",
  );
});

test("review pane stages, reverts, and commits through project git actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `REVIEW_GIT_${Date.now()}`;
  const harness = await mockSessionApi(
    page,
    `review changes ${marker}`,
    marker,
    {
      runtimeFileChangeEvents: true,
    },
  );
  await unlock(page);

  await page.getByTestId("review-pane-toggle").click();
  await page.getByTestId("review-mode-review").click();

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`review git actions ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const changeList = page.getByTestId("review-change-list");
  await expect(changeList).toContainText("src/app.ts");
  await expect(changeList).toContainText("docs/review-plan.md");
  await expect(page.getByTestId("review-git-status")).toContainText(
    "2 repo changes",
  );

  const docsChange = page.getByTestId("review-change-item").filter({
    hasText: "docs/review-plan.md",
  });
  await docsChange.click();
  await page.getByTestId("review-change-stage").click();
  await expect
    .poll(() => {
      const req = harness.lastProjectGitActionRequest();
      const paths = Array.isArray(req?.body?.paths)
        ? req?.body?.paths.map((item) => String(item))
        : [];
      return `${req?.action ?? ""}|${paths.join(",")}`;
    })
    .toBe("stage|docs/review-plan.md");
  await expect(docsChange).toContainText("Staged");

  await page.getByTestId("review-change-revert").click();
  await expect
    .poll(() => {
      const req = harness.lastProjectGitActionRequest();
      const paths = Array.isArray(req?.body?.paths)
        ? req?.body?.paths.map((item) => String(item))
        : [];
      return `${req?.action ?? ""}|${paths.join(",")}`;
    })
    .toBe("revert|docs/review-plan.md");
  await expect(changeList).not.toContainText("docs/review-plan.md");

  const srcChange = page.getByTestId("review-change-item").filter({
    hasText: "src/app.ts",
  });
  await srcChange.click();
  await page.getByTestId("review-change-stage").click();
  await expect
    .poll(() => {
      const req = harness.lastProjectGitActionRequest();
      const paths = Array.isArray(req?.body?.paths)
        ? req?.body?.paths.map((item) => String(item))
        : [];
      return `${req?.action ?? ""}|${paths.join(",")}`;
    })
    .toBe("stage|src/app.ts");

  await page.getByTestId("review-commit-message").fill("Native review commit");
  await page.getByTestId("review-commit-btn").click();
  await expect
    .poll(() => {
      const req = harness.lastProjectGitActionRequest();
      return `${req?.action ?? ""}|${String(req?.body?.message ?? "")}`;
    })
    .toBe("commit|Native review commit");
  await expect(page.getByTestId("review-change-empty")).toBeVisible();
  await expect(page.getByTestId("review-git-status")).toContainText(
    "0 repo changes",
  );
});

test("review pane scopes notes to the selected file and lets the reviewer dismiss them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `REVIEW_LINKED_${Date.now()}`;
  const assistantReply = [
    `src/app.ts still couples the review adapter to the chat shell. ${marker}`,
    `docs/review-plan.md should call out the new review workflow separately. ${marker}`,
  ].join("\n\n");
  const harness = await mockSessionApi(page, assistantReply, marker, {
    runtimeFileChangeEvents: true,
  });
  await unlock(page);

  await page.getByTestId("review-pane-toggle").click();
  await page.getByTestId("review-mode-review").click();

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`review linked files ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const docsChange = page.getByTestId("review-change-item").filter({
    hasText: "docs/review-plan.md",
  });
  await docsChange.click();
  await expect(page.getByTestId("review-file-findings")).toContainText(
    "docs/review-plan.md",
  );
  await expect(page.getByTestId("review-file-findings")).not.toContainText(
    "src/app.ts",
  );

  await page.getByTestId("review-change-mark-reviewed").click();
  await expect(page.getByTestId("review-change-mark-reviewed")).toContainText(
    "Reviewed",
  );

  await page
    .getByTestId("review-file-findings")
    .getByTestId("review-finding-dismiss")
    .click();
  await expect(page.getByTestId("review-file-findings")).toHaveCount(0);
  await expect(page.getByTestId("review-restore-dismissed")).toBeVisible();
});

test("review pane consumes app-server diff notifications before file cards settle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `REVIEW_PROTOCOL_DIFF_${Date.now()}`;
  const harness = await mockSessionApi(
    page,
    `protocol diff ${marker}`,
    marker,
    {
      protocolDiffEvents: true,
    },
  );
  await unlock(page);

  await page.getByTestId("review-pane-toggle").click();
  await page.getByTestId("review-mode-review").click();

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`consume protocol diff ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  await expect(page.getByTestId("review-turn-diff")).toContainText(
    "+++ b/docs/review-plan.md",
  );
  await expect(page.getByTestId("review-turn-diff")).toContainText(
    '+  return "native workbench";',
  );
});

test("fork session creates a branch session in project list", async ({
  page,
}) => {
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

test("new session stays active after remote session binding", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `REMOTE_BIND_${Date.now()}`;
  const harness = await mockSessionApi(page, `remote bind ${marker}`, marker, {
    includeSecondSession: true,
  });
  await unlock(page);

  const initialActive = page.locator(".session-chip-tree.active").first();
  await expect(initialActive).toHaveAttribute(
    "data-session-id",
    "session_cli_1",
  );

  await page.getByRole("button", { name: "New Session", exact: true }).click();

  const draftActive = page.locator(".session-chip-tree.active").first();
  const draftSessionID =
    (await draftActive.getAttribute("data-session-id")) ?? "";
  expect(draftSessionID.startsWith("session_")).toBeTruthy();

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`keep the new remote session active ${marker}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const remoteSession = page.locator(
    '.session-chip-tree[data-session-id="session_cli_new_1"]',
  );
  await expect(remoteSession).toHaveCount(1);
  await expect(remoteSession).toHaveClass(/active/);
  await expect(
    page.locator('.session-chip-tree[data-session-id="session_cli_1"].active'),
  ).toHaveCount(0);
  await expect(
    page.locator(".message.message-assistant pre", { hasText: marker }),
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
    "Ask Codex to work in this project...",
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

test("session stream keeps command runtime cards out of the main chat flow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `RUNTIME_CARD_${Date.now()}`;
  const harness = await mockSessionApi(page, `runtime ${marker}`, marker, {
    streamPattern: "completion-once",
    runtimeCommandEvents: true,
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`emit runtime command cards ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);
  await expect(page.locator(".timeline")).not.toContainText("Command Started");
  await expect(page.locator(".timeline")).not.toContainText(
    "Command Completed",
  );
  await expect(page.locator(".timeline")).not.toContainText("ls -la");
});

test("terminal drawer mirrors project command output and supports clear shortcut", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `TERMINAL_DRAWER_${Date.now()}`;
  const harness = await mockSessionApi(page, `terminal ${marker}`, marker, {
    streamPattern: "completion-once",
    runtimeCommandEvents: true,
  });
  await unlock(page);

  await expect(page.getByTestId("terminal-drawer")).toHaveCount(0);
  await page.getByTestId("terminal-drawer-toggle").click();
  await expect(page.getByTestId("terminal-drawer")).toBeVisible();
  await expect(page.getByTestId("terminal-empty-copy")).toBeVisible();

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`emit terminal output ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const terminalList = page.getByTestId("terminal-command-list");
  await expect(terminalList).toContainText("Command Completed");
  await expect(terminalList).toContainText("ls -la");
  await expect(terminalList).toContainText("README.md");
  await expect(terminalList).toContainText("pty_cmd_1");

  await page.keyboard.press("Control+l");
  await expect(page.getByTestId("terminal-command-list")).toHaveCount(0);
  await expect(page.getByTestId("terminal-empty-copy")).toBeVisible();

  await page.keyboard.press("Control+j");
  await expect(page.getByTestId("terminal-drawer")).toHaveCount(0);
  await page.keyboard.press("Control+j");
  await expect(page.getByTestId("terminal-drawer")).toBeVisible();
});

test("terminal drawer consumes app-server output delta and stdin interaction events", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `TERMINAL_PROTOCOL_${Date.now()}`;
  const harness = await mockSessionApi(
    page,
    `terminal protocol ${marker}`,
    marker,
    {
      protocolTerminalEvents: true,
    },
  );
  await unlock(page);

  await page.getByTestId("terminal-drawer-toggle").click();
  await expect(page.getByTestId("terminal-drawer")).toBeVisible();

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`emit terminal protocol ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const terminalList = page.getByTestId("terminal-command-list");
  await expect(terminalList).toContainText("pty_cmd_1");
  await expect(terminalList).toContainText("total 4");
  await expect(terminalList).toContainText("README.md");
  await expect(terminalList).toContainText("1 inputs");
  await expect(terminalList).toContainText("q");
});

test("pending command approval resumes the session after allow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PENDING_APPROVAL_${Date.now()}`;
  const harness = await mockSessionApi(
    page,
    `approval complete ${marker}`,
    marker,
    {
      pendingRequestScenario: "command-approval",
    },
  );
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`needs approval ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const pendingCard = page.getByTestId("pending-request-card");
  await expect(pendingCard).toContainText("Approve command");
  await expect(pendingCard).toContainText("git status --short");
  await expect(page.getByText("Awaiting command approval.")).toBeVisible();

  await page.getByTestId("pending-request-decision-accept").click();
  await expect
    .poll(() => harness.lastPendingResolveRequest()?.result)
    .toEqual({ decision: "accept" });

  await expect(page.getByTestId("pending-request-card")).toHaveCount(0, {
    timeout: 12000,
  });
  await expect(
    page.locator(".message.message-assistant pre", {
      hasText: marker,
    }),
  ).toHaveCount(1);
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
    "Ask Codex to work in this project...",
  );
  await composer.fill(`run long task ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);

  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stopButton).toBeVisible();
  await stopButton.click();
  await expect(page.getByRole("heading", { name: "Stopping" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled({
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
    "Ask Codex to work in this project...",
  );
  await composer.fill(`initial prompt ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled({
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
    "Ask Codex to work in this project...",
  );
  await composer.fill(`check cursor replay safety ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);
  await expect(
    page.locator(".message.message-assistant pre", { hasText: marker }),
  ).toHaveCount(1);
  await expect(page.getByText("Response Started")).toHaveCount(0);
  await expect(page.getByText("Server Completed")).toHaveCount(0);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".session-side")).toBeVisible();
  await expect(
    page.locator(".message.message-assistant pre", { hasText: marker }),
  ).toHaveCount(1);
  await expect(page.getByText("Response Started")).toHaveCount(0);
  await expect(page.getByText("Server Completed")).toHaveCount(0);
  await expect
    .poll(() =>
      harness.sessionOneStreamAfterValues().some((value) => value > 0),
    )
    .toBe(true);
  await expect(page.locator(".session-alert")).toHaveCount(0);
});

test("archived session can be restored and survives reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `SESSION_RESTORE_${Date.now()}`;
  await mockSessionApi(page, `restore session ${marker}`, marker, {
    streamPattern: "completion-once",
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`archive and restore ${marker}`);
  await composer.press("Enter");
  await expect(
    page.locator(".message.message-assistant pre", { hasText: marker }),
  ).toHaveCount(1);

  const activeSession = page.locator(".session-chip-tree.active").first();
  const sessionID = (await activeSession.getAttribute("data-session-id")) ?? "";
  expect(sessionID).not.toBe("");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Archive session");
    await dialog.accept();
  });
  await page
    .locator(".chat-head-actions")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(
    page.locator(`.session-chip-tree[data-session-id="${sessionID}"]`),
  ).toHaveCount(0);

  const restoreResponse = await page.evaluate(
    async ({ sessionID }) => {
      const response = await fetch(
        `/v2/codex/sessions/${encodeURIComponent(sessionID)}/unarchive`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer rlm_test.token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ host_id: "local_1" }),
        },
      );
      return {
        ok: response.ok,
        body: await response.json(),
      };
    },
    { sessionID },
  );
  expect(restoreResponse.ok).toBeTruthy();

  await revisitWorkspace(page);
  const restoredSession = page
    .locator(`.session-chip-tree[data-session-id="${sessionID}"]`)
    .first();
  await expect(restoredSession).toBeVisible();
  await restoredSession.click();
  await expect(
    page.locator(".message.message-assistant pre", { hasText: marker }),
  ).toHaveCount(1);
  await expect(page.getByText("Response Started")).toHaveCount(0);
  await expect(page.getByText("Server Completed")).toHaveCount(0);
});

test("server replay ignores cursor but timeline stays deduped", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `CURSOR_IGNORE_${Date.now()}`;
  const harness = await mockSessionApi(
    page,
    `dedupe replay ${marker}`,
    marker,
    {
      streamPattern: "completion-once",
      ignoreStreamAfterCursor: true,
    },
  );
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`dedupe replay ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);
  const assistantEntry = page.locator(".message.message-assistant pre", {
    hasText: marker,
  });
  await expect(assistantEntry).toHaveCount(1);

  await revisitWorkspace(page);
  await expect(assistantEntry).toHaveCount(1);
  await expect
    .poll(() =>
      harness.sessionOneStreamAfterValues().some((value) => value > 0),
    )
    .toBe(true);
  await expect(page.locator(".session-alert")).toHaveCount(0);
});

test("websocket stream replay renders once without SSE fallback", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `WS_REPLAY_${Date.now()}`;
  await installMockSessionWebSocket(page, {
    sessionID: "session_cli_1",
    marker,
  });
  const harness = await mockSessionApi(page, `ws replay ${marker}`, marker, {
    streamPattern: "ready-only",
  });
  await unlock(page);

  const assistantEntry = page.locator(".message.message-assistant pre", {
    hasText: marker,
  });
  await expect(assistantEntry).toHaveCount(1);
  await expect.poll(() => harness.sessionOneSSECalls()).toBe(0);

  await revisitWorkspace(page);
  await expect(assistantEntry).toHaveCount(1);
  await expect.poll(() => harness.sessionOneSSECalls()).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as unknown as {
            __mockWsState?: {
              calls: Array<{ sessionID: string; after: number }>;
            };
          }
        ).__mockWsState;
        return Array.isArray(state?.calls)
          ? state.calls.some(
              (item) => item.sessionID === "session_cli_1" && item.after > 0,
            )
          : false;
      }),
    )
    .toBe(true);
});

test("websocket reset reconnect completes once without SSE fallback", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `WS_RESET_${Date.now()}`;
  await installMockSessionWebSocket(page, {
    sessionID: "session_cli_1",
    marker,
    mode: "reset-reconnect",
  });
  const harness = await mockSessionApi(page, `ws reset ${marker}`, marker, {
    streamPattern: "ready-only",
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`trigger ws reset ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);
  await page.evaluate(() => {
    (
      window as unknown as {
        __mockWsControl?: { triggerResetReconnect?: () => void };
      }
    ).__mockWsControl?.triggerResetReconnect?.();
  });

  const assistantEntry = page.locator(".message.message-assistant pre", {
    hasText: marker,
  });
  await expect(assistantEntry).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled({
    timeout: 12000,
  });
  await expect.poll(() => harness.sessionOneSSECalls()).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as unknown as {
            __mockWsState?: {
              calls: Array<{ sessionID: string; after: number }>;
            };
          }
        ).__mockWsState;
        return Array.isArray(state?.calls)
          ? state.calls.some(
              (item) => item.sessionID === "session_cli_1" && item.after > 0,
            )
          : false;
      }),
    )
    .toBe(true);
});

test("websocket repeated resets reconnect and complete once", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `WS_FLAKY_${Date.now()}`;
  await installMockSessionWebSocket(page, {
    sessionID: "session_cli_1",
    marker,
    mode: "flaky-reset-reconnect",
  });
  const harness = await mockSessionApi(page, `ws flaky ${marker}`, marker, {
    streamPattern: "ready-only",
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`trigger ws flaky reset ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);
  await page.evaluate(() => {
    (
      window as unknown as {
        __mockWsControl?: { triggerFlakyResetReconnect?: () => void };
      }
    ).__mockWsControl?.triggerFlakyResetReconnect?.();
  });

  const assistantEntry = page.locator(".message.message-assistant pre", {
    hasText: marker,
  });
  await expect(assistantEntry).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled({
    timeout: 15000,
  });
  await expect.poll(() => harness.sessionOneSSECalls()).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as unknown as {
            __mockWsState?: {
              calls: Array<{ sessionID: string; after: number }>;
            };
          }
        ).__mockWsState;
        if (!Array.isArray(state?.calls)) return false;
        const calls = state.calls.filter(
          (item) => item.sessionID === "session_cli_1",
        );
        const hasAfter2 = calls.some((item) => item.after >= 2);
        const hasAfter3 = calls.some((item) => item.after >= 3);
        return hasAfter2 && hasAfter3;
      }),
    )
    .toBe(true);
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

  const projectFilter = page.getByPlaceholder("Search projects or threads");
  await projectFilter.fill("session 2");
  await expect
    .poll(async () => {
      return page.evaluate(
        () =>
          window.localStorage.getItem("remote_llm_session_tree_prefs_v1") ?? "",
      );
    })
    .toContain("session 2");

  await revisitWorkspace(page);
  await expect(projectFilter).toHaveValue("session 2");
  await expect(page.locator(".project-host-pill").first()).toBeVisible();
});

test("project create and rename use project name as primary label", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PROJECT_NAME_${Date.now()}`;
  await mockSessionApi(page, `project ${marker}`, marker);
  await unlock(page);

  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("/path/to/project").fill("/srv/demo-app");
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

test("only the active project surfaces management actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PROJECT_ACTIONS_${Date.now()}`;
  await mockSessionApi(page, `project actions ${marker}`, marker);
  await unlock(page);

  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("/path/to/project").fill("/srv/demo-app");
  await page.getByPlaceholder("My Project").fill("Demo App");
  await page.getByRole("button", { name: "Create" }).click();

  const demoProjectNode = page.locator(".project-node", {
    has: page.locator(".project-chip-main strong", { hasText: "Demo App" }),
  });
  const workProjectNode = page.locator(".project-node", {
    has: page.locator(".project-chip-main strong", { hasText: "work" }),
  });

  await expect(
    demoProjectNode
      .locator(".project-node-actions")
      .getByRole("button", { name: "Rename" }),
  ).toBeVisible();
  await expect(
    demoProjectNode
      .locator(".project-node-actions")
      .getByRole("button", { name: "Archive" }),
  ).toBeVisible();

  await workProjectNode.locator(".project-chip").click();

  await expect(demoProjectNode.locator(".project-node-actions")).toHaveCount(0);
  await expect(
    workProjectNode
      .locator(".project-node-actions")
      .getByRole("button", { name: "Rename" }),
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

  const archiveDemoNode = page
    .locator(".project-node", {
      has: page.locator(".project-chip-main strong", {
        hasText: "Archive Demo",
      }),
    })
    .first();
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

test("active project is prioritized to top of project list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PROJECT_ORDER_${Date.now()}`;
  await mockSessionApi(page, `project order ${marker}`, marker);
  await unlock(page);

  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("/path/to/project").fill("/srv/zzz-project");
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
    page.locator(".project-chip-main strong", {
      hasText: "Stale Cache Project",
    }),
  ).toHaveCount(0);
});

test("background completion shows one alert and unread badge", async ({
  page,
}) => {
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

test("background completion does not steal active session after manual switch", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `BG_SWITCH_${Date.now()}`;
  await mockSessionApi(page, `background ${marker}`, marker, {
    includeSecondSession: true,
    backgroundCompletion: true,
    backgroundCompletionDelayMS: 400,
  });
  await unlock(page);

  const session1Chip = page.locator(
    '.session-chip-tree[data-session-id="session_cli_1"]',
  );
  const session2Chip = page.locator(
    '.session-chip-tree[data-session-id="session_cli_2"]',
  );
  await session2Chip.click();
  await expect(session2Chip).toHaveClass(/active/);

  await session1Chip.click();
  await expect(session1Chip).toHaveClass(/active/);

  const alert = page.locator(".session-alert", {
    hasText: "Session 2 completed",
  });
  await expect(alert).toBeVisible();
  await expect(session1Chip).toHaveClass(/active/);
  await expect(session2Chip).not.toHaveClass(/active/);
});

test("generic session title is auto-derived from first prompt", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `TITLE_${Date.now()}`;
  await mockSessionApi(page, `title ${marker}`, marker);
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
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

test("session title stream update overrides fallback title", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `TITLE_EVT_${Date.now()}`;
  await mockSessionApi(page, `title-evt ${marker}`, marker, {
    titleUpdate: "QA Release Checklist",
  });
  await unlock(page);

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
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
    "Ask Codex to work in this project...",
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

  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled({
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
    if (text.includes("reconnecting") || text.includes("needs attention")) {
      sawRetryState = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  expect(sawRetryState).toBeTruthy();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(streamStatus).toContainText("Live", { timeout: 15000 });

  const composer = page.getByPlaceholder(
    "Ask Codex to work in this project...",
  );
  await composer.fill(`recover ${marker}`);
  await composer.press("Enter");
  await expect.poll(() => harness.runRequests()).toBe(1);
  await expect(
    page.locator(".message.message-assistant pre", {
      hasText: `recover ${marker}`,
    }),
  ).toHaveCount(1, { timeout: 15000 });
  await expect
    .poll(() => harness.sessionOneStreamAfterValues().length >= 3)
    .toBe(true);
  expect(harness.sessionOneStreamAfterValues().slice(0, 3)).toEqual([0, 0, 0]);

  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("pinning session reorders tree and persists across reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const marker = `PIN_${Date.now()}`;
  await mockSessionApi(page, `pin ${marker}`, marker, {
    includeSecondSession: true,
  });
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

  await revisitWorkspace(page);
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
    page.getByPlaceholder("Ask Codex to work in this project..."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();
});
