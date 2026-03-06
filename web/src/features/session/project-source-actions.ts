import type {
  Dispatch,
  SetStateAction,
} from "react";
import {
  discoverCodexSessions,
  listHosts,
  listProjects,
  listSessions,
  upsertHost,
  type Host,
  type SessionRecord,
} from "../../api";
import type { WorkspaceDirectory } from "../../domains/session";
import { DEFAULT_WORKSPACE_PATH } from "./config";
import {
  buildDiscoveredProjects,
  buildProjectsFromRecords,
} from "./project-sync";
import type { SessionLastStatus } from "./types";

type SyncProjectsOptions = {
  source?: "discovery" | "server";
  preserveMissingSessions?: boolean;
  preserveMissingProjects?: boolean;
  preserveOnEmptyResult?: boolean;
};

type CreateProjectSourceActionsDeps = {
  activeWorkspacePath: string;
  workspaces: WorkspaceDirectory[];
  setSourceProjectIDs: Dispatch<SetStateAction<string[]>>;
  syncProjectsFromDiscovery: (
    projects: ReturnType<typeof buildDiscoveredProjects>,
    options?: SyncProjectsOptions,
  ) => void;
  syncProjectsFromServer: (
    projects: ReturnType<typeof buildProjectsFromRecords>,
  ) => void;
  setThreadJobState: (
    threadID: string,
    jobID: string,
    status?: SessionLastStatus,
  ) => void;
};

function normalizeLastStatus(raw: string | undefined): SessionLastStatus {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "running" || value === "pending") return "running";
  if (value === "succeeded") return "succeeded";
  if (value === "failed") return "failed";
  if (value === "canceled") return "canceled";
  return "idle";
}

export function createProjectSourceActions(
  deps: CreateProjectSourceActionsDeps,
) {
  const ensureLocalCodexHost = async (
    authToken: string,
    currentHosts: Host[],
  ): Promise<Host[]> => {
    if (currentHosts.some((host) => host.connection_mode === "local")) {
      return currentHosts;
    }
    await upsertHost(authToken, {
      name: "local-default",
      connection_mode: "local",
      host: "localhost",
      workspace: deps.activeWorkspacePath || DEFAULT_WORKSPACE_PATH,
    });
    return listHosts(authToken);
  };

  const refreshProjectsFromDiscovery = async (
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError = true,
  ) => {
    if (!discoverEnabled) {
      deps.setSourceProjectIDs([]);
      deps.syncProjectsFromDiscovery(
        buildDiscoveredProjects(sourceHosts, [], DEFAULT_WORKSPACE_PATH),
        {
          source: "discovery",
        },
      );
      return;
    }
    try {
      const discovered = await discoverCodexSessions(authToken, {
        all_hosts: true,
        fanout: Math.max(1, Math.min(8, sourceHosts.length || 1)),
        limit_per_host: 120,
      });
      deps.setSourceProjectIDs([]);
      deps.syncProjectsFromDiscovery(
        buildDiscoveredProjects(
          sourceHosts,
          discovered.body.targets ?? [],
          DEFAULT_WORKSPACE_PATH,
        ),
        { source: "discovery" },
      );
    } catch {
      deps.setSourceProjectIDs([]);
      if (!preserveOnError) {
        deps.syncProjectsFromDiscovery(
          buildDiscoveredProjects(sourceHosts, [], DEFAULT_WORKSPACE_PATH),
          {
            source: "discovery",
          },
        );
      }
    }
  };

  const reconcileFromSessionRecords = (records: SessionRecord[]) => {
    const currentByID = new Map<
      string,
      { activeJobID: string; lastJobStatus: SessionLastStatus }
    >();
    for (const workspace of deps.workspaces) {
      for (const thread of workspace.sessions) {
        currentByID.set(thread.id, {
          activeJobID: thread.activeJobID.trim(),
          lastJobStatus: thread.lastJobStatus,
        });
      }
    }

    for (const record of records) {
      const sessionID = record.id.trim();
      if (!sessionID) continue;
      const current = currentByID.get(sessionID);
      if (!current) continue;
      const nextStatus = normalizeLastStatus(record.last_status);
      const nextJobID =
        nextStatus === "running"
          ? record.last_run_id?.trim() || current.activeJobID
          : "";
      if (
        current.activeJobID === nextJobID &&
        current.lastJobStatus === nextStatus
      ) {
        continue;
      }
      deps.setThreadJobState(sessionID, nextJobID, nextStatus);
    }
  };

  const refreshProjectsFromSource = async (
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError = true,
  ) => {
    try {
      const [projects, sessions] = await Promise.all([
        listProjects(authToken, 600, { runtime: "codex" }),
        listSessions(authToken, 1200, { runtime: "codex" }),
      ]);
      deps.setSourceProjectIDs(
        projects
          .map((project) => project.id.trim())
          .filter((id) => id !== ""),
      );
      const built = buildProjectsFromRecords(
        sourceHosts,
        projects,
        sessions,
        DEFAULT_WORKSPACE_PATH,
      );
      const hasSessionItems = built.some((project) => project.sessions.length > 0);
      if (!hasSessionItems && discoverEnabled) {
        throw new Error("empty session snapshot");
      }
      // Server snapshot is authoritative for project/session membership.
      deps.syncProjectsFromServer(built);
      reconcileFromSessionRecords(sessions);
      return;
    } catch {
      deps.setSourceProjectIDs([]);
      // fall through to discovery fallback
    }
    await refreshProjectsFromDiscovery(
      authToken,
      sourceHosts,
      discoverEnabled,
      preserveOnError,
    );
  };

  return {
    ensureLocalCodexHost,
    refreshProjectsFromSource,
  };
}
