import { useRef } from "react";
import {
  loadPersistedSessionEventCursors,
  persistSessionEventCursors,
} from "./persistence";

export function useSessionEventCursor() {
  const sessionEventCursorRef = useRef<Map<string, number>>(
    loadPersistedSessionEventCursors(),
  );

  function setSessionEventCursor(sessionID: string, cursor: number) {
    const normalizedSessionID = sessionID.trim();
    if (!normalizedSessionID || !Number.isFinite(cursor) || cursor <= 0) return;
    const current = sessionEventCursorRef.current.get(normalizedSessionID) ?? 0;
    if (cursor <= current) return;
    sessionEventCursorRef.current.set(normalizedSessionID, cursor);
    persistSessionEventCursors(sessionEventCursorRef.current);
  }

  function deleteSessionEventCursor(sessionID: string) {
    const normalizedSessionID = sessionID.trim();
    if (!normalizedSessionID) return;
    if (!sessionEventCursorRef.current.delete(normalizedSessionID)) return;
    persistSessionEventCursors(sessionEventCursorRef.current);
  }

  function pruneSessionEventCursors(validSessionIDs: Set<string>): boolean {
    let changed = false;
    for (const sessionID of Array.from(sessionEventCursorRef.current.keys())) {
      if (validSessionIDs.has(sessionID)) continue;
      sessionEventCursorRef.current.delete(sessionID);
      changed = true;
    }
    if (changed) {
      persistSessionEventCursors(sessionEventCursorRef.current);
    }
    return changed;
  }

  return {
    sessionEventCursorRef,
    setSessionEventCursor,
    deleteSessionEventCursor,
    pruneSessionEventCursors,
  };
}
