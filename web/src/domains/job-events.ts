import type { RunJobEvent } from "../api";

export function summarizeJobEventLine(event: RunJobEvent): string {
  const host = event.host_name || event.host_id || "target";
  switch (event.type) {
    case "target.started":
      return `${host} started.`;
    case "target.done":
      if ((event.status ?? "").toLowerCase() === "ok") {
        return `${host} completed.`;
      }
      return [
        host,
        "failed",
        typeof event.exit_code === "number" ? `exit ${event.exit_code}` : "",
        event.error || "",
      ]
        .filter((part) => part.trim() !== "")
        .join(" · ");
    case "job.cancel_requested":
      return "Cancel requested.";
    case "job.canceled":
      return "Session canceled.";
    case "job.failed":
      return event.error ? `Session failed: ${event.error}` : "Session failed.";
    case "job.succeeded":
      return "Session completed.";
    default:
      return "";
  }
}
