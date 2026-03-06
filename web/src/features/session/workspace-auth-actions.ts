import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import {
  type AuditEvent,
  getMetrics,
  healthz,
  listAudit,
  listHosts,
  listRunJobs,
  listRuns,
  listRuntimes,
  type Host,
  type MetricsResponse,
  type RunRecord,
  type RunJobRecord,
  type RuntimeInfo,
} from "../../api";
import { clearStoredToken, storeToken } from "../../domains/auth-token";
import { isJobActive } from "./runtime-utils";

type CreateWorkspaceAuthActionsDeps = {
  selectedRuntime: string;
  workspacesLength: number;

  setIsRefreshing: Dispatch<SetStateAction<boolean>>;
  setHealth: Dispatch<SetStateAction<string>>;
  setHosts: Dispatch<SetStateAction<Host[]>>;
  setRuntimes: Dispatch<SetStateAction<RuntimeInfo[]>>;
  setJobs: Dispatch<SetStateAction<RunJobRecord[]>>;
  setRuns: Dispatch<SetStateAction<RunRecord[]>>;
  setAuditEvents: Dispatch<SetStateAction<AuditEvent[]>>;
  setMetrics: Dispatch<SetStateAction<MetricsResponse | null>>;
  setAllHosts: Dispatch<SetStateAction<boolean>>;
  setSelectedHostIDs: Dispatch<SetStateAction<string[]>>;
  setSelectedRuntime: Dispatch<SetStateAction<string>>;
  setActiveJobID: Dispatch<SetStateAction<string>>;
  setActiveJob: Dispatch<SetStateAction<RunJobRecord | null>>;

  setToken: Dispatch<SetStateAction<string>>;
  setTokenInput: Dispatch<SetStateAction<string>>;
  setAuthError: Dispatch<SetStateAction<string>>;
  setAuthPhase: Dispatch<SetStateAction<"checking" | "locked" | "ready">>;

  ensureLocalCodexHost: (authToken: string, hosts: Host[]) => Promise<Host[]>;
  refreshProjectsFromSource: (
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError?: boolean,
  ) => Promise<void>;

  jobEventCursorRef: MutableRefObject<Map<string, number>>;
  jobStreamSeenRef: MutableRefObject<Map<string, boolean>>;
  completionAlertCutoffMSRef: MutableRefObject<number>;
};

export function createWorkspaceAuthActions(
  deps: CreateWorkspaceAuthActionsDeps,
) {
  const loadWorkspace = async (authToken: string) => {
    const refreshStartedAtMS = Date.now();
    deps.setIsRefreshing(true);
    try {
      const [
        healthBody,
        fetchedHosts,
        nextRuntimes,
        nextJobs,
        nextRuns,
        nextAudit,
        nextMetrics,
      ] = await Promise.all([
        healthz(),
        listHosts(authToken),
        listRuntimes(authToken),
        listRunJobs(authToken, 20),
        listRuns(authToken, 20),
        listAudit(authToken, 80),
        getMetrics(authToken),
      ]);
      const nextHosts = await deps.ensureLocalCodexHost(authToken, fetchedHosts);

      deps.setHealth(`ok ${healthBody.timestamp}`);
      deps.setHosts(nextHosts);
      deps.setRuntimes(nextRuntimes);
      deps.setJobs(nextJobs);
      deps.setRuns(nextRuns);
      deps.setAuditEvents(nextAudit);
      deps.setMetrics(nextMetrics);

      const localHost = nextHosts.find(
        (host) => host.connection_mode === "local",
      );
      if (localHost) {
        deps.setAllHosts(false);
        deps.setSelectedHostIDs([localHost.id]);
      } else {
        deps.setSelectedHostIDs((prev) => {
          const nextSelected = prev.filter((id) =>
            nextHosts.some((host) => host.id === id),
          );
          if (nextSelected.length > 0) return nextSelected;
          if (nextHosts.length > 0) return [nextHosts[0].id];
          return [];
        });
      }

      const codexRuntime = nextRuntimes.find(
        (runtime) => runtime.name === "codex",
      );
      if (codexRuntime) {
        deps.setSelectedRuntime("codex");
      } else if (
        !nextRuntimes.some((runtime) => runtime.name === deps.selectedRuntime)
      ) {
        deps.setSelectedRuntime(nextRuntimes[0]?.name ?? "codex");
      }

      await deps.refreshProjectsFromSource(
        authToken,
        nextHosts,
        nextRuntimes.some((runtime) => runtime.name === "codex"),
        deps.workspacesLength > 0,
      );

      const running = nextJobs.find((job) => isJobActive(job));
      if (running) {
        deps.setActiveJobID(running.id);
        deps.setActiveJob(running);
      } else {
        deps.setActiveJobID("");
        deps.setActiveJob(null);
      }

      for (const job of nextJobs) {
        if (!isJobActive(job)) continue;
        if (!deps.jobEventCursorRef.current.has(job.id)) {
          deps.jobEventCursorRef.current.set(job.id, 0);
        }
        if (!deps.jobStreamSeenRef.current.has(job.id)) {
          deps.jobStreamSeenRef.current.set(job.id, false);
        }
      }

      // Only surface completion alerts for events that happen after this sync starts.
      deps.completionAlertCutoffMSRef.current = refreshStartedAtMS;
    } catch (error) {
      deps.setHealth(`error: ${String(error)}`);
      throw error;
    } finally {
      deps.setIsRefreshing(false);
    }
  };

  const unlockWorkspace = async (candidateToken: string) => {
    const trimmed = candidateToken.trim();
    if (!trimmed) {
      deps.setAuthError("token is required");
      deps.setAuthPhase("locked");
      return;
    }

    deps.setAuthPhase("checking");
    deps.setAuthError("");

    try {
      await Promise.all([listRuntimes(trimmed), listHosts(trimmed)]);
      storeToken(trimmed);
      deps.setToken(trimmed);
      deps.setTokenInput(trimmed);
      await loadWorkspace(trimmed);
      deps.setAuthPhase("ready");
    } catch (error) {
      clearStoredToken();
      deps.setToken("");
      deps.setAuthPhase("locked");
      deps.setAuthError(`token validation failed: ${String(error)}`);
    }
  };

  return {
    loadWorkspace,
    unlockWorkspace,
  };
}
