import { type TimelineState } from "../../domains/session";
import { isCodexProtocolNoiseLine } from "../../domains/timeline-noise";
import type { CodexRuntimeCard } from "./stream-types";
import { clipStreamText, normalizeSessionTitle } from "./utils";
export type { CodexRuntimeCard } from "./stream-types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

export function extractThreadIDFromCodexSessionResponse(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  const session = asRecord(record.session);
  if (session) {
    const id = typeof session.id === "string" ? session.id.trim() : "";
    if (id) return id;
  }
  const thread = asRecord(record.thread);
  if (thread) {
    const id = typeof thread.id === "string" ? thread.id.trim() : "";
    if (id) return id;
  }
  return "";
}

export function extractTurnIDFromPayload(value: unknown): string {
  const payload = asRecord(value);
  if (!payload) return "";
  const directKeys = ["turn_id", "turnId", "id"];
  for (const key of directKeys) {
    const direct = typeof payload[key] === "string" ? payload[key].trim() : "";
    if (direct) return direct;
  }
  const turn = asRecord(payload.turn);
  if (turn) {
    const id = typeof turn.id === "string" ? turn.id.trim() : "";
    if (id) return id;
  }
  const item = asRecord(payload.item);
  if (item) {
    const id = typeof item.turn_id === "string"
      ? item.turn_id.trim()
      : typeof item.turnId === "string"
        ? item.turnId.trim()
        : "";
    if (id) return id;
  }
  return "";
}

export function codexRPCMethodAndParams(
  eventType: string,
  payload: Record<string, unknown>,
): {
  method: string;
  params: Record<string, unknown>;
} {
  const rawMethod = typeof payload.method === "string"
    ? payload.method.trim()
    : "";
  const method = rawMethod
    ? rawMethod
    : eventType.startsWith("codexrpc.")
      ? eventType.slice("codexrpc.".length).replace(/\./g, "/")
      : "";
  const params = asRecord(payload.params) ?? {};
  return {
    method: method.toLowerCase(),
    params,
  };
}

export function extractRunIDFromCodexRPC(
  payload: Record<string, unknown>,
): string {
  const { params } = codexRPCMethodAndParams("codexrpc", payload);
  const direct = typeof params.run_id === "string"
    ? params.run_id.trim()
    : typeof params.runId === "string"
      ? params.runId.trim()
      : "";
  if (direct) return direct;
  return extractTurnIDFromPayload(params);
}

type GatherMessageTextOptions = {
  preserveWhitespace?: boolean;
};

function gatherMessageText(
  value: unknown,
  depth = 0,
  options?: GatherMessageTextOptions,
): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") {
    if (options?.preserveWhitespace) {
      return value === "" ? [] : [value];
    }
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      out.push(...gatherMessageText(item, depth + 1, options));
    }
    return out;
  }

  const record = asRecord(value);
  if (!record) return [];
  const out: string[] = [];
  const keys = ["text", "message", "content", "parts", "output_text"];
  for (const key of keys) {
    if (!(key in record)) continue;
    out.push(...gatherMessageText(record[key], depth + 1, options));
  }
  return out;
}

function pickAssistantTextFromEvent(event: Record<string, unknown>): string {
  const eventType = typeof event.type === "string" ? event.type : "";
  if (eventType === "item.completed") {
    const item = asRecord(event.item);
    if (!item) return "";
    const itemType = typeof item.type === "string" ? item.type : "";
    const itemRole = typeof item.role === "string" ? item.role : "";
    if (
      itemType !== "" &&
      itemType !== "agent_message" &&
      itemType !== "assistant_message" &&
      itemType !== "message" &&
      itemRole !== "assistant"
    ) {
      return "";
    }
    return gatherMessageText(item).join("\n").trim();
  }

  if (eventType === "response.completed") {
    const response = asRecord(event.response);
    if (!response) return "";
    return gatherMessageText(response).join("\n").trim();
  }

  return "";
}

export function parseCodexAssistantTextFromStdout(
  stdout: string,
  allowPlainTextFallback = true,
): string {
  if (!stdout.trim()) return "";
  const lines = stdout.split(/\r?\n/);
  const messages: string[] = [];
  const deltas: string[] = [];
  const plainLines: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (!isCodexProtocolNoiseLine(line)) {
        plainLines.push(line);
      }
      continue;
    }
    const event = asRecord(parsed);
    if (!event) continue;
    const eventType = typeof event.type === "string" ? event.type : "";
    if (eventType.endsWith(".delta")) {
      const deltaText = gatherMessageText(event.delta ?? event, 0, {
        preserveWhitespace: true,
      }).join("");
      if (deltaText.trim()) {
        deltas.push(deltaText);
      }
    }
    const text = pickAssistantTextFromEvent(event);
    if (!text) continue;
    if (!messages.includes(text)) {
      messages.push(text);
    }
  }
  if (messages.length > 0) {
    return messages[messages.length - 1] ?? "";
  }
  if (deltas.length > 0) {
    return deltas.join("").trim();
  }
  if (allowPlainTextFallback && plainLines.length > 0) {
    return plainLines.join("\n").trim();
  }
  return "";
}

function pickSessionTitleFromEvent(event: Record<string, unknown>): string {
  const direct = normalizeSessionTitle(
    typeof event.title === "string" ? event.title : "",
  );
  if (direct) return direct;
  const nestedKeys = ["thread", "session", "payload", "item", "data", "meta"];
  for (const key of nestedKeys) {
    const record = asRecord(event[key]);
    if (!record) continue;
    const title = normalizeSessionTitle(
      typeof record.title === "string" ? record.title : "",
    );
    if (title) return title;
  }
  return "";
}

export function parseCodexSessionTitleFromStdout(stdout: string): string {
  if (!stdout.trim()) return "";
  const lines = stdout.split(/\r?\n/);
  let latest = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = asRecord(parsed);
    if (!event) continue;
    const eventType =
      typeof event.type === "string" ? event.type.toLowerCase() : "";
    if (eventType.includes("title")) {
      const titled = pickSessionTitleFromEvent(event);
      if (titled) latest = titled;
      continue;
    }
    if (eventType === "thread.started" || eventType === "session.started") {
      const titled = pickSessionTitleFromEvent(event);
      if (titled) latest = titled;
    }
  }
  return latest;
}

export function runtimeStateFromStatus(status: string): TimelineState {
  const normalized = status.trim().toLowerCase();
  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "declined"
  ) {
    return "error";
  }
  if (normalized === "completed" || normalized === "succeeded") {
    return "success";
  }
  return "running";
}

function codexEventIncludesApproval(text: string): boolean {
  return /(approval|declined|rejected by user|approval settings)/i.test(text);
}

export type ParsedCodexFileChange = {
  kind: string;
  path: string;
  diff: string;
};

const CODEX_FILE_CHANGE_METADATA_PREFIX = "__codex_file_changes__:";

function normalizeCodexFileChange(raw: unknown): ParsedCodexFileChange | null {
  const change = asRecord(raw);
  if (!change) return null;
  const kind =
    typeof change.kind === "string" && change.kind.trim() !== ""
      ? change.kind.trim()
      : "update";
  const path =
    typeof change.path === "string" && change.path.trim() !== ""
      ? change.path.trim()
      : "";
  if (!path) return null;
  const diff =
    typeof change.diff === "string" && change.diff.trim() !== ""
      ? change.diff.trim()
      : "";
  return { kind, path, diff };
}

function collectCodexFileChanges(raw: unknown): ParsedCodexFileChange[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw
    .map((value) => normalizeCodexFileChange(value))
    .filter((value): value is ParsedCodexFileChange => value !== null);
}

function summarizeCodexFileChanges(raw: unknown): string {
  const changes = collectCodexFileChanges(raw);
  if (changes.length === 0) {
    return "No file changes were reported.";
  }
  const lines: string[] = [];
  for (const change of changes) {
    lines.push(`${change.kind} ${change.path}`);
    if (lines.length >= 5) break;
  }
  if (lines.length === 0) {
    return "No file changes were reported.";
  }
  if (changes.length > lines.length) {
    lines.push(`...and ${changes.length - lines.length} more`);
  }
  return [
    lines.join("\n"),
    `${CODEX_FILE_CHANGE_METADATA_PREFIX}${encodeURIComponent(
      JSON.stringify(changes),
    )}`,
  ].join("\n");
}

export function parseCodexFileChangesBody(
  body: string,
): ParsedCodexFileChange[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  const markerLine = trimmed
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(CODEX_FILE_CHANGE_METADATA_PREFIX));
  if (markerLine) {
    const encoded = markerLine.slice(CODEX_FILE_CHANGE_METADATA_PREFIX.length);
    try {
      const parsed = JSON.parse(decodeURIComponent(encoded)) as unknown;
      const changes = collectCodexFileChanges(parsed);
      if (changes.length > 0) {
        return changes;
      }
    } catch {
      // Fall back to legacy line parsing below.
    }
  }

  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" &&
        !line.startsWith("...and ") &&
        !line.startsWith(CODEX_FILE_CHANGE_METADATA_PREFIX),
    )
    .map((line) => {
      const [kindToken, ...pathParts] = line.split(/\s+/);
      return {
        kind: kindToken.trim() || "update",
        path: pathParts.join(" ").trim(),
        diff: "",
      };
    })
    .filter((change) => change.path !== "");
}

export function buildCodexRuntimeCardFromEvent(
  event: Record<string, unknown>,
  runID: string,
): CodexRuntimeCard | null {
  const eventType =
    typeof event.type === "string" ? event.type.trim().toLowerCase() : "";
  if (!eventType) return null;

  if (eventType === "error") {
    const message =
      typeof event.message === "string" ? event.message.trim() : "";
    if (!message || !codexEventIncludesApproval(message)) {
      return null;
    }
    return {
      key: `${runID}:approval:error:${message}`,
      title: "Approval Required",
      body: message,
      state: "error",
    };
  }

  if (eventType === "turn.failed") {
    const error = asRecord(event.error);
    const message =
      error && typeof error.message === "string"
        ? error.message.trim()
        : typeof event.message === "string"
          ? event.message.trim()
          : "";
    if (!message || !codexEventIncludesApproval(message)) {
      return null;
    }
    return {
      key: `${runID}:approval:turn_failed:${message}`,
      title: "Approval Required",
      body: message,
      state: "error",
    };
  }

  if (
    eventType !== "item.started" &&
    eventType !== "item.updated" &&
    eventType !== "item.completed"
  ) {
    return null;
  }

  const item = asRecord(event.item);
  if (!item) return null;
  const itemID =
    typeof item.id === "string" && item.id.trim() !== ""
      ? item.id.trim()
      : "item";
  const itemType =
    typeof item.type === "string" ? item.type.trim().toLowerCase() : "";
  if (!itemType) return null;

  if (itemType === "command_execution") {
    const command =
      typeof item.command === "string" && item.command.trim() !== ""
        ? item.command.trim()
        : "command";
    const status =
      typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
    const effectiveStatus =
      status || (eventType === "item.completed" ? "completed" : "in_progress");
    const exitCode =
      typeof item.exit_code === "number" ? ` exit=${item.exit_code}` : "";
    const output =
      typeof item.aggregated_output === "string"
        ? item.aggregated_output.trim()
        : "";
    if (effectiveStatus === "declined") {
      return {
        key: `${runID}:approval:${itemID}:${effectiveStatus}`,
        title: "Approval Required",
        body: `Command was declined: ${command}`,
        state: "error",
      };
    }
    const title =
      effectiveStatus === "failed"
        ? "Command Failed"
        : effectiveStatus === "completed"
          ? "Command Completed"
          : "Command Started";
    const bodyParts = [`${command}${exitCode}`.trim()];
    if (output) {
      bodyParts.push(clipStreamText(output, 1200));
    }
    return {
      key: `${runID}:command:${itemID}:${effectiveStatus}`,
      title,
      body: bodyParts.join("\n"),
      state: runtimeStateFromStatus(effectiveStatus),
    };
  }

  if (itemType === "file_change") {
    const status =
      typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
    const effectiveStatus =
      status || (eventType === "item.completed" ? "completed" : "in_progress");
    return {
      key: `${runID}:patch:${itemID}:${effectiveStatus}`,
      title:
        effectiveStatus === "failed"
          ? "Patch Failed"
          : effectiveStatus === "completed"
            ? "Patch Applied"
            : "Patch Started",
      body: summarizeCodexFileChanges(item.changes),
      state: runtimeStateFromStatus(effectiveStatus),
    };
  }

  if (itemType === "mcp_tool_call") {
    const server =
      typeof item.server === "string" && item.server.trim() !== ""
        ? item.server.trim()
        : "server";
    const tool =
      typeof item.tool === "string" && item.tool.trim() !== ""
        ? item.tool.trim()
        : "tool";
    const status =
      typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
    const effectiveStatus =
      status || (eventType === "item.completed" ? "completed" : "in_progress");
    const errorRecord = asRecord(item.error);
    const errorMessage =
      errorRecord && typeof errorRecord.message === "string"
        ? errorRecord.message.trim()
        : "";
    const body = [`${server}.${tool}`];
    if (errorMessage) body.push(errorMessage);
    return {
      key: `${runID}:tool:${itemID}:${effectiveStatus}`,
      title:
        effectiveStatus === "failed"
          ? "Tool Failed"
          : effectiveStatus === "completed"
            ? "Tool Completed"
            : "Tool Started",
      body: body.join("\n"),
      state: runtimeStateFromStatus(effectiveStatus),
    };
  }

  if (itemType === "web_search") {
    const status =
      typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
    const effectiveStatus =
      status || (eventType === "item.completed" ? "completed" : "in_progress");
    const query =
      typeof item.query === "string" && item.query.trim() !== ""
        ? item.query.trim()
        : "(empty query)";
    return {
      key: `${runID}:tool:${itemID}:web_search:${effectiveStatus}`,
      title:
        effectiveStatus === "completed" ? "Tool Completed" : "Tool Started",
      body: `web_search\n${query}`,
      state: runtimeStateFromStatus(effectiveStatus),
    };
  }

  if (itemType === "collab_tool_call") {
    const status =
      typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
    const effectiveStatus =
      status || (eventType === "item.completed" ? "completed" : "in_progress");
    const tool =
      typeof item.tool === "string" && item.tool.trim() !== ""
        ? item.tool.trim()
        : "collab_tool";
    return {
      key: `${runID}:tool:${itemID}:collab:${effectiveStatus}`,
      title:
        effectiveStatus === "failed"
          ? "Tool Failed"
          : effectiveStatus === "completed"
            ? "Tool Completed"
            : "Tool Started",
      body: tool,
      state: runtimeStateFromStatus(effectiveStatus),
    };
  }

  if (itemType === "error") {
    const message =
      typeof item.message === "string" ? item.message.trim() : "";
    if (!message || !codexEventIncludesApproval(message)) {
      return null;
    }
    return {
      key: `${runID}:approval:${itemID}:item_error`,
      title: "Approval Required",
      body: message,
      state: "error",
    };
  }

  return null;
}

export function parseCodexEventsIncremental(
  stdout: string,
  offset: number,
): { nextOffset: number; events: Array<Record<string, unknown>> } {
  if (!stdout) return { nextOffset: 0, events: [] };
  let cursor = Math.max(0, Math.min(offset, stdout.length));
  if (cursor > 0 && stdout[cursor - 1] !== "\n") {
    const nextBreak = stdout.indexOf("\n", cursor);
    if (nextBreak < 0) {
      return { nextOffset: cursor, events: [] };
    }
    cursor = nextBreak + 1;
  }
  const events: Array<Record<string, unknown>> = [];
  let scan = cursor;
  while (scan < stdout.length) {
    const nextBreak = stdout.indexOf("\n", scan);
    if (nextBreak < 0) break;
    const line = stdout.slice(scan, nextBreak).trim();
    scan = nextBreak + 1;
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = asRecord(parsed);
    if (event) events.push(event);
  }
  return { nextOffset: scan, events };
}
