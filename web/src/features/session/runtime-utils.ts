import type { RunJobRecord } from "../../api";
import type { TimelineEntry } from "../../domains/session";
import { parseCodexAssistantTextFromStdout } from "./codex-parsing";
import { clipStreamText } from "./utils";

export function isJobActive(job: RunJobRecord | null | undefined): boolean {
  if (!job) return false;
  return job.status === "pending" || job.status === "running";
}

export function sessionEventHostLabel(payload: Record<string, unknown>): string {
  const hostName =
    typeof payload.host_name === "string" ? payload.host_name.trim() : "";
  if (hostName) return hostName;
  const hostID =
    typeof payload.host_id === "string" ? payload.host_id.trim() : "";
  if (hostID) return hostID;
  return "target";
}

export function lastUserPromptFromTimeline(timeline: TimelineEntry[]): string {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry.kind !== "user") continue;
    const body = entry.body.trim();
    if (body) return body;
  }
  return "";
}

export function sessionCompletionCopy(status: "succeeded" | "failed" | "canceled"): {
  suffix: string;
  body: string;
} {
  switch (status) {
    case "succeeded":
      return { suffix: "completed", body: "New response is ready." };
    case "failed":
      return {
        suffix: "failed",
        body: "Response failed. Open this session for details.",
      };
    case "canceled":
      return { suffix: "canceled", body: "Response was canceled." };
    default:
      return { suffix: "updated", body: "Session status changed." };
  }
}

export function extractAssistantTextFromJob(job: RunJobRecord): string {
  const response = job.response;
  if (
    !response ||
    !("targets" in response) ||
    !Array.isArray(response.targets) ||
    response.targets.length === 0
  ) {
    return "";
  }
  const targetMessages: string[] = [];
  const multiTarget = response.targets.length > 1;
  for (const target of response.targets) {
    const stdout = target?.result?.stdout;
    if (typeof stdout !== "string" || !stdout.trim()) continue;
    const assistantText =
      parseCodexAssistantTextFromStdout(stdout, false) ||
      parseCodexAssistantTextFromStdout(stdout, true);
    if (!assistantText) continue;
    if (multiTarget) {
      const hostName = target.host?.name?.trim() || target.host?.id || "target";
      targetMessages.push(`[${hostName}] ${assistantText}`);
    } else {
      targetMessages.push(assistantText);
    }
  }
  return targetMessages.join("\n\n").trim();
}

export function jobHasTargetFailures(job: RunJobRecord): boolean {
  const response = job.response;
  if (!response || !("summary" in response) || !("targets" in response)) {
    return false;
  }
  const failedCount =
    typeof response.summary?.failed === "number" ? response.summary.failed : 0;
  if (failedCount > 0) return true;
  if (!Array.isArray(response.targets)) return false;
  return response.targets.some((target) => target?.ok === false);
}

export function summarizeTargetFailures(job: RunJobRecord): string {
  const response = job.response;
  if (!response || !("targets" in response) || !Array.isArray(response.targets)) {
    return "";
  }
  const lines: string[] = [];
  for (const target of response.targets) {
    if (target?.ok !== false) continue;
    const hostName = target.host?.name?.trim() || target.host?.id || "target";
    const stderr =
      typeof target.result?.stderr === "string" ? target.result.stderr.trim() : "";
    const reason =
      target.error?.trim() ||
      target.error_hint?.trim() ||
      (stderr ? stderr.split(/\r?\n/, 1)[0]?.trim() ?? "" : "");
    const suffix = reason ? `: ${clipStreamText(reason, 320)}` : "";
    lines.push(`${hostName} failed${suffix}`);
  }
  return lines.join("\n");
}

export function formatClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(ts: string | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}
