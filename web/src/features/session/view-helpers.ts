import type { CodexPlatformResult } from "../../api";
import type { SessionStreamHealthState } from "./stream-types";

const MESSAGE_COLLAPSE_LINE_LIMIT = 42;

export type MessageSegment =
  | {
      kind: "text";
      content: string;
    }
  | {
      kind: "code";
      lang: string;
      content: string;
    };

export function firstImageFile(
  source: FileList | File[] | null | undefined,
): File | null {
  if (!source) return null;
  const files = Array.from(source);
  for (const file of files) {
    if (file.type.toLowerCase().startsWith("image/")) {
      return file;
    }
  }
  return null;
}

export function dataTransferHasImage(
  data: DataTransfer | null | undefined,
): boolean {
  if (!data) return false;
  const itemTypes = Array.from(data.items ?? []).map((item) =>
    item.type.toLowerCase(),
  );
  if (itemTypes.some((type) => type.startsWith("image/"))) return true;
  return Boolean(firstImageFile(data.files));
}

export function parseMessageSegments(raw: string): MessageSegment[] {
  const body = raw ?? "";
  if (!body.trim()) {
    return [{ kind: "text", content: "" }];
  }
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  const segments: MessageSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(fencePattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      const text = body.slice(cursor, start);
      if (text.length > 0) {
        segments.push({ kind: "text", content: text });
      }
    }
    const lang = (match[1] ?? "").trim();
    const code = (match[2] ?? "").replace(/\n$/, "");
    segments.push({ kind: "code", lang, content: code });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) {
    const tail = body.slice(cursor);
    if (tail.length > 0) {
      segments.push({ kind: "text", content: tail });
    }
  }
  if (segments.length === 0) {
    segments.push({ kind: "text", content: body });
  }
  return segments;
}

export function shouldCollapseMessageBody(raw: string): boolean {
  if (!raw.trim()) return false;
  const lines = raw.split(/\r?\n/);
  if (lines.length > MESSAGE_COLLAPSE_LINE_LIMIT) return true;
  return raw.length > 7000;
}

export function statusTone(status: string): "ok" | "warn" | "err" {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "canceled") return "err";
  return "warn";
}

export function streamHealthTone(
  state: SessionStreamHealthState,
): "ok" | "warn" | "error" {
  if (state === "live") return "ok";
  if (state === "error") return "error";
  if (state === "offline") return "warn";
  return "warn";
}

export function streamHealthCopy(
  state: SessionStreamHealthState,
  retries: number,
): string {
  if (state === "live") return "live";
  if (state === "connecting") return "connecting";
  if (state === "reconnecting") {
    return retries > 0 ? `reconnecting (${retries})` : "reconnecting";
  }
  if (state === "error") {
    return retries > 0 ? `stream error (${retries})` : "stream error";
  }
  return "offline";
}

export function splitCSVValues(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function formatCodexPlatformResult(result: CodexPlatformResult | null): string {
  if (!result) return "No command executed yet.";
  const lines: string[] = [];
  lines.push(`operation: ${result.operation}`);
  lines.push(`status: ${result.ok ? "ok" : "error"}`);
  const command = Array.isArray(result.command)
    ? result.command.join(" ")
    : "";
  if (command) lines.push(`command: ${command}`);
  if (result.workdir) lines.push(`workdir: ${result.workdir}`);
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.error_hint) lines.push(`hint: ${result.error_hint}`);

  const stdout = result.result?.stdout?.trim() ?? "";
  const stderr = result.result?.stderr?.trim() ?? "";
  if (stdout) {
    lines.push("");
    lines.push("[stdout]");
    lines.push(stdout);
  }
  if (stderr) {
    lines.push("");
    lines.push("[stderr]");
    lines.push(stderr);
  }
  if (typeof result.json !== "undefined") {
    lines.push("");
    lines.push("[json]");
    try {
      lines.push(JSON.stringify(result.json, null, 2));
    } catch {
      lines.push(String(result.json));
    }
  }
  return lines.join("\n").trim();
}
