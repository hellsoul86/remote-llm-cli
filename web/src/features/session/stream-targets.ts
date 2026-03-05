import type { WorkspaceDirectory } from "../../domains/session";

function isLocalDraftSessionID(sessionID: string): boolean {
  return /^session_\d+_\d+$/.test(sessionID.trim());
}

type StreamTarget = {
  id: string;
  priority: number;
  updatedAtMS: number;
};

export function buildSessionStreamTargetIDs(
  workspaces: WorkspaceDirectory[],
  activeThreadID: string,
  maxSessionStreams: number,
): string[] {
  const byID = new Map<string, StreamTarget>();
  const touch = (idRaw: string, priority: number, updatedAtRaw: string) => {
    const id = idRaw.trim();
    if (!id) return;
    const parsed = Date.parse(updatedAtRaw);
    const updatedAtMS = Number.isFinite(parsed) ? parsed : 0;
    const existing = byID.get(id);
    if (
      !existing ||
      priority < existing.priority ||
      (priority === existing.priority && updatedAtMS > existing.updatedAtMS)
    ) {
      byID.set(id, { id, priority, updatedAtMS });
    }
  };

  for (const workspace of workspaces) {
    for (const thread of workspace.sessions) {
      if (isLocalDraftSessionID(thread.id)) continue;
      const priority =
        thread.id === activeThreadID
          ? 0
          : thread.activeJobID.trim()
            ? 1
            : thread.pinned
              ? 2
              : thread.unreadDone
                ? 3
                : 9;
      touch(thread.id, priority, thread.updatedAt);
    }
  }

  const ordered = Array.from(byID.values()).sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    if (left.updatedAtMS !== right.updatedAtMS) {
      return right.updatedAtMS - left.updatedAtMS;
    }
    return left.id.localeCompare(right.id);
  });

  if (maxSessionStreams <= 0) {
    return ordered.map((item) => item.id);
  }

  const pinned = ordered.filter((item) => item.priority <= 3);
  if (pinned.length >= maxSessionStreams) {
    return pinned.slice(0, maxSessionStreams).map((item) => item.id);
  }

  const chosen = [...pinned];
  const chosenIDs = new Set(chosen.map((item) => item.id));
  for (const item of ordered) {
    if (chosenIDs.has(item.id)) continue;
    chosen.push(item);
    chosenIDs.add(item.id);
    if (chosen.length >= maxSessionStreams) break;
  }
  return chosen.map((item) => item.id);
}
