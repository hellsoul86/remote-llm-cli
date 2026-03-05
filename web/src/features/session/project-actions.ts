import type { FormEvent } from "react";
import {
  deleteProject,
  type Host,
  listProjects,
  listSessions,
  upsertProject,
} from "../../api";
import type { TimelineEntry } from "../../domains/session";
import type { SessionTreeProject } from "./types";
import { resolveProjectTitle } from "./utils";

type CreateProjectActionsDeps = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  projectFormHostID: string;
  projectFormPath: string;
  projectFormTitle: string;
  hosts: Host[];
  sourceProjectIDSet: Set<string>;
  activeThreadID: string;
  addTimelineEntry: (
    entry: Omit<TimelineEntry, "id" | "createdAt">,
    threadID?: string,
  ) => void;
  setUpsertingProjectID: (id: string) => void;
  setDeletingProjectID: (id: string) => void;
  setSourceProjectIDs: (ids: string[]) => void;
  setActiveWorkspaceID: (id: string) => void;
  closeProjectComposer: () => void;
  refreshProjectsFromSource: (
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError?: boolean,
  ) => Promise<void>;
};

export function createProjectActions(deps: CreateProjectActionsDeps) {
  const canMutateProjects = () => {
    return deps.authPhase === "ready" && deps.token.trim() !== "";
  };

  const onCreateProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canMutateProjects()) return;
    const hostID = deps.projectFormHostID.trim();
    const path = deps.projectFormPath.trim();
    const title = deps.projectFormTitle.trim();
    if (!hostID || !path) {
      deps.addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Project Validation",
        body: "Server and project path are required.",
      });
      return;
    }

    deps.setUpsertingProjectID("__create__");
    try {
      const saved = await upsertProject(deps.token, {
        host_id: hostID,
        path,
        title: title || undefined,
        runtime: "codex",
      });
      await deps.refreshProjectsFromSource(deps.token, deps.hosts, false, true);
      if (saved.id.trim()) {
        deps.setActiveWorkspaceID(saved.id.trim());
      }
      deps.closeProjectComposer();
      deps.addTimelineEntry({
        kind: "system",
        state: "success",
        title: "Project Created",
        body: `${resolveProjectTitle(path, title)} · ${path}`,
      });
    } catch (error) {
      deps.addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Create Project Failed",
        body: String(error),
      });
    } finally {
      deps.setUpsertingProjectID("");
    }
  };

  const onRenameProject = async (project: SessionTreeProject) => {
    if (!canMutateProjects()) return;
    const currentTitle = resolveProjectTitle(project.path, project.title);
    const next = window.prompt("Project name", currentTitle);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      deps.addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Rename Project Failed",
        body: "Project name is required.",
      });
      return;
    }
    if (trimmed === currentTitle) return;

    deps.setUpsertingProjectID(project.id);
    try {
      const saved = await upsertProject(deps.token, {
        id: project.id,
        host_id: project.hostID,
        path: project.path,
        title: trimmed,
        runtime: "codex",
      });
      await deps.refreshProjectsFromSource(deps.token, deps.hosts, false, true);
      if (saved.id.trim()) {
        deps.setActiveWorkspaceID(saved.id.trim());
      }
      deps.addTimelineEntry({
        kind: "system",
        state: "success",
        title: "Project Renamed",
        body: `${currentTitle} -> ${trimmed}`,
      });
    } catch (error) {
      deps.addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Rename Project Failed",
        body: String(error),
      });
    } finally {
      deps.setUpsertingProjectID("");
    }
  };

  const onArchiveProject = async (
    projectID: string,
    projectHostID: string,
    projectPath: string,
    sessionCount: number,
  ) => {
    if (!canMutateProjects()) return;
    const sourceProjectID = projectID.trim();
    const sourceHostID = projectHostID.trim();
    const sourcePath = projectPath.trim();
    const loadingKey = sourceProjectID;

    const confirmed = window.confirm(`Archive empty project "${sourcePath}"?`);
    if (!confirmed) return;

    deps.setDeletingProjectID(loadingKey);

    let targetProjectID = sourceProjectID;
    let remoteProjectResolved = deps.sourceProjectIDSet.has(targetProjectID);
    try {
      if (!remoteProjectResolved) {
        try {
          const remoteProjects = await listProjects(deps.token, 600, {
            runtime: "codex",
          });
          deps.setSourceProjectIDs(
            remoteProjects
              .map((project) => project.id.trim())
              .filter((id) => id !== ""),
          );
          const matched =
            remoteProjects.find(
              (project) => project.id.trim() === sourceProjectID,
            ) ??
            remoteProjects.find(
              (project) =>
                project.host_id.trim() === sourceHostID &&
                project.path.trim() === sourcePath,
            );
          if (matched?.id?.trim()) {
            targetProjectID = matched.id.trim();
            remoteProjectResolved = true;
          }
        } catch {
          // no-op: keep fallback to local-only message below
        }
      }

      if (!remoteProjectResolved || !targetProjectID) {
        deps.addTimelineEntry(
          {
            kind: "system",
            state: "error",
            title: "Archive Unavailable",
            body: "Project is local-only and cannot be archived remotely.",
          },
          deps.activeThreadID,
        );
        return;
      }

      let resolvedSessionCount = sessionCount;
      try {
        const remoteSessions = await listSessions(deps.token, 200, {
          project_id: targetProjectID,
          runtime: "codex",
        });
        resolvedSessionCount = remoteSessions.length;
      } catch {
        // fallback to current UI count
      }

      if (resolvedSessionCount > 0) {
        deps.addTimelineEntry(
          {
            kind: "system",
            state: "error",
            title: "Archive Blocked",
            body:
              resolvedSessionCount === 1
                ? "Project still has 1 session. Archive it first."
                : `Project still has ${resolvedSessionCount} sessions. Archive them first.`,
          },
          deps.activeThreadID,
        );
        return;
      }

      await deleteProject(deps.token, targetProjectID);
      await deps.refreshProjectsFromSource(deps.token, deps.hosts, false, true);
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "success",
          title: "Project Archived",
          body: projectPath,
        },
        deps.activeThreadID,
      );
    } catch (error) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Project Archive Failed",
          body: String(error),
        },
        deps.activeThreadID,
      );
    } finally {
      deps.setDeletingProjectID("");
    }
  };

  return {
    onCreateProject,
    onRenameProject,
    onArchiveProject,
  };
}
