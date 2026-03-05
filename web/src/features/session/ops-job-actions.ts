import { cancelRunJob, type RunJobRecord } from "../../api";
import type { ConversationThread } from "../../domains/session";
import { isJobActive } from "./runtime-utils";

type CreateOpsJobActionsDeps = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  runningThreadJobs: Array<{ threadID: string; jobID: string }>;
  setThreadJobState: (
    threadID: string,
    jobID: string,
    status?: ConversationThread["lastJobStatus"],
  ) => void;
  setOpsNotice: (notice: string) => void;
  loadWorkspace: (authToken: string) => Promise<void>;
};

export function createOpsJobActions(deps: CreateOpsJobActionsDeps) {
  const canRun = () => deps.authPhase === "ready" && deps.token.trim() !== "";

  const onCancelJob = async (job: RunJobRecord) => {
    if (!canRun()) return;
    if (!isJobActive(job)) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Cancel job '${job.id}'?`);
      if (!confirmed) return;
    }
    try {
      await cancelRunJob(deps.token, job.id);
      const related = deps.runningThreadJobs.find((item) => item.jobID === job.id);
      if (related) {
        deps.setThreadJobState(related.threadID, "", "canceled");
      }
      deps.setOpsNotice(`Cancel requested for ${job.id}.`);
      await deps.loadWorkspace(deps.token);
    } catch (error) {
      deps.setOpsNotice(`Cancel failed for ${job.id}: ${String(error)}`);
    }
  };

  return {
    onCancelJob,
  };
}
