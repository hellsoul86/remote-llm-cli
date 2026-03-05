import { type TimelineState } from "../../domains/session";
import { isCodexProtocolNoiseLine } from "../../domains/timeline-noise";
import { normalizeSessionTitle } from "./utils";

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

function gatherMessageText(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      out.push(...gatherMessageText(item, depth + 1));
    }
    return out;
  }

  const record = asRecord(value);
  if (!record) return [];
  const out: string[] = [];
  const keys = ["text", "message", "content", "parts", "output_text"];
  for (const key of keys) {
    if (!(key in record)) continue;
    out.push(...gatherMessageText(record[key], depth + 1));
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
      const deltaText = gatherMessageText(event.delta ?? event).join("");
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
