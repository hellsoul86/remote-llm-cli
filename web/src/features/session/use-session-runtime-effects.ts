import { type MutableRefObject, useEffect } from "react";
import {
  discoverCodexModels,
  getRunJob,
  type Host,
  type RunJobRecord,
  type RuntimeInfo,
} from "../../api";
import type { SessionStreamRuntimeState } from "./session-stream-controller";

type UseSessionRuntimeEffectsArgs = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  appMode: "session" | "ops";

  sessionStreamTargetIDs: string[];
  sessionStreamStateRef: MutableRefObject<Map<string, SessionStreamRuntimeState>>;
  streamAuthTokenRef: MutableRefObject<string>;
  stopAllSessionStreams: () => void;
  startSessionStream: (sessionID: string, authToken: string) => void;
  stopSessionStream: (
    sessionID: string,
    options?: { preserveRunState?: boolean; preserveHealth?: boolean },
  ) => void;

  activeSessionHostID: string;
  runtimes: RuntimeInfo[];
  setSessionModelDefault: (model: string) => void;
  setSessionModelOptions: (models: string[]) => void;

  hosts: Host[];
  runningThreadJobsLength: number;
  submittingThreadID: string;
  refreshProjectsFromSource: (
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError?: boolean,
  ) => Promise<void>;

  activeThreadID: string;
  activeThreadActiveJobID: string;
  knownJobIDSet: Set<string>;
  setActiveJobID: (jobID: string) => void;
  setActiveJob: (job: RunJobRecord | null) => void;
};

export function useSessionRuntimeEffects(args: UseSessionRuntimeEffectsArgs) {
  useEffect(() => {
    const ready = args.authPhase === "ready" && args.token.trim() !== "";
    if (!ready) {
      args.streamAuthTokenRef.current = "";
      args.stopAllSessionStreams();
      return;
    }
    if (args.streamAuthTokenRef.current !== args.token) {
      args.stopAllSessionStreams();
      args.streamAuthTokenRef.current = args.token;
    }

    const expected = new Set(args.sessionStreamTargetIDs);
    for (const sessionID of expected) {
      if (!args.sessionStreamStateRef.current.has(sessionID)) {
        args.startSessionStream(sessionID, args.token);
      }
    }
    for (const sessionID of Array.from(args.sessionStreamStateRef.current.keys())) {
      if (expected.has(sessionID)) continue;
      args.stopSessionStream(sessionID);
    }
  }, [args.authPhase, args.token, args.sessionStreamTargetIDs]);

  useEffect(() => {
    return () => {
      args.stopAllSessionStreams();
    };
  }, []);

  useEffect(() => {
    if (args.authPhase !== "ready" || !args.token.trim()) return;
    if (!args.activeSessionHostID) return;
    if (!args.runtimes.some((runtime) => runtime.name === "codex")) return;
    let canceled = false;
    void discoverCodexModels(args.token, { host_id: args.activeSessionHostID })
      .then((catalog) => {
        if (canceled) return;
        const nextDefault = catalog.default_model?.trim() || "";
        const nextModels = Array.isArray(catalog.models)
          ? catalog.models.filter((name) => name.trim() !== "")
          : [];
        args.setSessionModelDefault(nextDefault);
        args.setSessionModelOptions(nextModels);
      })
      .catch(() => {
        if (canceled) return;
        args.setSessionModelDefault("");
        args.setSessionModelOptions([]);
      });
    return () => {
      canceled = true;
    };
  }, [args.authPhase, args.token, args.activeSessionHostID, args.runtimes]);

  useEffect(() => {
    if (args.authPhase !== "ready" || !args.token.trim()) return;
    if (args.appMode !== "session") return;
    if (!args.runtimes.some((runtime) => runtime.name === "codex")) return;
    if (args.hosts.length === 0) return;
    if (args.runningThreadJobsLength > 0 || args.submittingThreadID !== "") {
      return;
    }

    let canceled = false;
    const refresh = async () => {
      try {
        await args.refreshProjectsFromSource(args.token, args.hosts, true, true);
      } catch {
        // no-op: best-effort title/session sync
      }
    };

    const timer = window.setInterval(() => {
      if (canceled) return;
      void refresh();
    }, 25000);

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [
    args.authPhase,
    args.token,
    args.appMode,
    args.hosts,
    args.runtimes,
    args.runningThreadJobsLength,
    args.submittingThreadID,
  ]);

  useEffect(() => {
    if (args.appMode !== "session" || args.authPhase !== "ready" || !args.token.trim()) {
      return;
    }
    const activeRunID = args.activeThreadActiveJobID.trim();
    if (!activeRunID || !args.knownJobIDSet.has(activeRunID)) {
      args.setActiveJobID("");
      args.setActiveJob(null);
      return;
    }
    void getRunJob(args.token, activeRunID)
      .then((job) => {
        args.setActiveJobID(job.id);
        args.setActiveJob(job);
      })
      .catch(() => {
        args.setActiveJobID("");
        args.setActiveJob(null);
      });
  }, [
    args.appMode,
    args.authPhase,
    args.token,
    args.activeThreadID,
    args.activeThreadActiveJobID,
    args.knownJobIDSet,
  ]);
}
