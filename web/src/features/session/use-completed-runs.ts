import { type MutableRefObject, useCallback, useRef } from "react";
import {
  loadPersistedCompletedRuns,
  persistCompletedRuns,
} from "./persistence";

export function useCompletedRuns(
  completedJobsRef: MutableRefObject<Set<string>>,
  maxSize: number,
) {
  const completedRunsHydratedRef = useRef(false);

  const trimCompletedRunsStore = useCallback(() => {
    while (completedJobsRef.current.size > maxSize) {
      const oldest = completedJobsRef.current.values().next().value;
      if (typeof oldest !== "string" || !oldest.trim()) break;
      completedJobsRef.current.delete(oldest);
    }
  }, [completedJobsRef, maxSize]);

  const hydrateCompletedRuns = useCallback(() => {
    if (completedRunsHydratedRef.current) return;
    completedRunsHydratedRef.current = true;
    const persisted = loadPersistedCompletedRuns();
    if (persisted.size === 0) return;
    for (const runID of persisted) {
      completedJobsRef.current.add(runID);
    }
    trimCompletedRunsStore();
    persistCompletedRuns(completedJobsRef.current);
  }, [completedJobsRef, trimCompletedRunsStore]);

  const hasCompletedRun = useCallback(
    (runID: string): boolean => {
      const normalized = runID.trim();
      if (!normalized) return false;
      return completedJobsRef.current.has(normalized);
    },
    [completedJobsRef],
  );

  const markRunCompleted = useCallback(
    (runID: string): boolean => {
      const normalized = runID.trim();
      if (!normalized) return false;
      if (completedJobsRef.current.has(normalized)) return false;
      completedJobsRef.current.add(normalized);
      trimCompletedRunsStore();
      persistCompletedRuns(completedJobsRef.current);
      return true;
    },
    [completedJobsRef, trimCompletedRunsStore],
  );

  const clearCompletedRuns = useCallback(() => {
    completedJobsRef.current.clear();
  }, [completedJobsRef]);

  return {
    hydrateCompletedRuns,
    hasCompletedRun,
    markRunCompleted,
    clearCompletedRuns,
  };
}
