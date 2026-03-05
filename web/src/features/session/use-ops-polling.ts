import { useEffect } from "react";
import {
  getMetrics,
  listAudit,
  listRunJobs,
  listRuns,
  type RunJobRecord,
  type RunRecord,
  type AuditEvent,
  type MetricsResponse,
} from "../../api";
import { isJobActive } from "./runtime-utils";

type UseOpsPollingArgs = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  appMode: "session" | "ops";
  activeJobID: string;
  setJobs: (jobs: RunJobRecord[]) => void;
  setRuns: (runs: RunRecord[]) => void;
  setAuditEvents: (audit: AuditEvent[]) => void;
  setMetrics: (metrics: MetricsResponse | null) => void;
  setActiveJobID: (jobID: string) => void;
  setActiveJob: (job: RunJobRecord | null) => void;
};

export function useOpsPolling(args: UseOpsPollingArgs) {
  useEffect(() => {
    if (args.authPhase !== "ready" || !args.token.trim() || args.appMode !== "ops") {
      return;
    }

    let canceled = false;
    const timer = window.setInterval(async () => {
      try {
        const [nextJobs, nextRuns, nextAudit, nextMetrics] = await Promise.all([
          listRunJobs(args.token, 20),
          listRuns(args.token, 20),
          listAudit(args.token, 80),
          getMetrics(args.token),
        ]);
        if (canceled) return;
        args.setJobs(nextJobs);
        args.setRuns(nextRuns);
        args.setAuditEvents(nextAudit);
        args.setMetrics(nextMetrics);

        if (!args.activeJobID) {
          const running = nextJobs.find((job) => isJobActive(job));
          if (running) {
            args.setActiveJobID(running.id);
            args.setActiveJob(running);
          }
        }
      } catch {
        if (canceled) return;
      }
    }, 5000);

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [
    args.authPhase,
    args.token,
    args.appMode,
    args.activeJobID,
    args.setJobs,
    args.setRuns,
    args.setAuditEvents,
    args.setMetrics,
    args.setActiveJobID,
    args.setActiveJob,
  ]);
}
