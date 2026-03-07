import { type SessionTreePrefs } from "./types";

const SESSION_TREE_PREFS_KEY = "remote_llm_session_tree_prefs_v1";
const SESSION_EVENT_CURSOR_KEY = "remote_llm_session_event_cursor_v1";
const COMPLETED_RUNS_KEY = "remote_llm_completed_runs_v1";
const MAX_PERSISTED_SESSION_CURSORS = 1200;
const MAX_PERSISTED_COMPLETED_RUNS = 2400;

export function loadPersistedSessionEventCursors(): Map<string, number> {
  if (typeof window === "undefined") {
    return new Map();
  }
  const raw = window.localStorage.getItem(SESSION_EVENT_CURSOR_KEY);
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed)
      .map(([sessionID, cursor]) => {
        const normalizedID = sessionID.trim();
        const normalizedCursor =
          typeof cursor === "number" ? cursor : Number(cursor);
        return [normalizedID, normalizedCursor] as const;
      })
      .filter(
        ([sessionID, cursor]) =>
          sessionID !== "" && Number.isFinite(cursor) && cursor > 0,
      )
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_PERSISTED_SESSION_CURSORS);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

export function persistSessionEventCursors(map: Map<string, number>) {
  if (typeof window === "undefined") return;
  const entries = Array.from(map.entries())
    .filter(
      ([sessionID, cursor]) =>
        sessionID.trim() !== "" && Number.isFinite(cursor) && cursor > 0,
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PERSISTED_SESSION_CURSORS);
  const payload: Record<string, number> = {};
  for (const [sessionID, cursor] of entries) {
    payload[sessionID] = cursor;
  }
  window.localStorage.setItem(SESSION_EVENT_CURSOR_KEY, JSON.stringify(payload));
}

export function loadPersistedCompletedRuns(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  const raw = window.localStorage.getItem(COMPLETED_RUNS_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const out = new Set<string>();
    for (const value of parsed) {
      if (typeof value !== "string") continue;
      const normalized = value.trim();
      if (!normalized) continue;
      out.add(normalized);
      if (out.size >= MAX_PERSISTED_COMPLETED_RUNS) break;
    }
    return out;
  } catch {
    return new Set();
  }
}

export function persistCompletedRuns(set: Set<string>) {
  if (typeof window === "undefined") return;
  const values = Array.from(set).filter((runID) => runID.trim() !== "");
  const trimmed =
    values.length > MAX_PERSISTED_COMPLETED_RUNS
      ? values.slice(values.length - MAX_PERSISTED_COMPLETED_RUNS)
      : values;
  window.localStorage.setItem(COMPLETED_RUNS_KEY, JSON.stringify(trimmed));
}

export function loadSessionTreePrefs(): SessionTreePrefs {
  if (typeof window === "undefined") {
    return { projectFilter: "", collapsedHostIDs: [], sidebarCollapsed: false };
  }
  const raw = window.localStorage.getItem(SESSION_TREE_PREFS_KEY);
  if (!raw) {
    return { projectFilter: "", collapsedHostIDs: [], sidebarCollapsed: false };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionTreePrefs>;
    const projectFilter =
      typeof parsed.projectFilter === "string" ? parsed.projectFilter : "";
    const collapsedHostIDs = Array.isArray(parsed.collapsedHostIDs)
      ? parsed.collapsedHostIDs.filter(
          (item): item is string => typeof item === "string" && item.trim() !== "",
        )
      : [];
    const sidebarCollapsed = Boolean(parsed.sidebarCollapsed);
    return { projectFilter, collapsedHostIDs, sidebarCollapsed };
  } catch {
    return { projectFilter: "", collapsedHostIDs: [], sidebarCollapsed: false };
  }
}

export function persistSessionTreePrefs(prefs: SessionTreePrefs) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_TREE_PREFS_KEY, JSON.stringify(prefs));
}

export function clearSessionRuntimePersistence() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_EVENT_CURSOR_KEY);
  window.localStorage.removeItem(COMPLETED_RUNS_KEY);
}
