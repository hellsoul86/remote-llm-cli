import type { SessionEventRecord } from "../../api";
import { extractRunIDFromCodexRPC } from "./codex-parsing";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

export function sessionPayloadRecord(
  event: SessionEventRecord,
): Record<string, unknown> {
  return asRecord(event.payload) ?? {};
}

export function sessionEventRunID(event: SessionEventRecord): string {
  const direct = event.run_id?.trim() ?? "";
  if (direct) return direct;
  const payload = sessionPayloadRecord(event);
  if (event.type.startsWith("codexrpc.")) {
    const fromRPC = extractRunIDFromCodexRPC(payload);
    if (fromRPC) return fromRPC;
  }
  const fromPayload =
    typeof payload.job_id === "string" ? payload.job_id.trim() : "";
  return fromPayload;
}

export function decodeSessionEventRecord(
  input: unknown,
): SessionEventRecord | null {
  const payload = asRecord(input);
  if (!payload) return null;
  const seq = typeof payload.seq === "number" ? payload.seq : Number(payload.seq);
  if (!Number.isFinite(seq) || seq <= 0) return null;
  const sessionID =
    typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  const eventType = typeof payload.type === "string" ? payload.type.trim() : "";
  if (!sessionID || !eventType) return null;
  const createdAt =
    typeof payload.created_at === "string" && payload.created_at.trim()
      ? payload.created_at
      : new Date().toISOString();
  const runID = typeof payload.run_id === "string" ? payload.run_id : undefined;
  return {
    seq,
    session_id: sessionID,
    run_id: runID,
    type: eventType,
    payload: payload.payload,
    created_at: createdAt,
  };
}
