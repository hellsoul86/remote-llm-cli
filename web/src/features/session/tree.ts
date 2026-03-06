import { type Host } from "../../api";
import { type WorkspaceDirectory } from "../../domains/session";
import {
  type SessionTreeHost,
  type SessionTreeProject,
} from "./types";
import { resolveProjectTitle } from "./utils";

export function buildSessionTreeHosts(
  hosts: Host[],
  workspaces: WorkspaceDirectory[],
  activeWorkspaceID: string,
): SessionTreeHost[] {
  const hostLookup = new Map<string, Host>();
  for (const host of hosts) {
    hostLookup.set(host.id, host);
  }

  const groups = new Map<string, SessionTreeHost>();
  for (const workspace of workspaces) {
    const hostID = workspace.hostID?.trim() || "unknown";
    const host = hostLookup.get(hostID);
    const group = groups.get(hostID) ?? {
      hostID,
      hostName: workspace.hostName || host?.name || hostID,
      hostAddress: host
        ? `${host.user ? `${host.user}@` : ""}${host.host}:${host.port}`
        : "",
      projects: [],
    };

    const project: SessionTreeProject = {
      id: workspace.id,
      hostID,
      title: resolveProjectTitle(workspace.path, workspace.title),
      path: workspace.path,
      updatedAt: workspace.updatedAt,
      sessions: [...workspace.sessions]
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          if (a.unreadDone !== b.unreadDone) return a.unreadDone ? -1 : 1;
          const aRunning = a.activeJobID.trim() !== "";
          const bRunning = b.activeJobID.trim() !== "";
          if (aRunning !== bRunning) return aRunning ? -1 : 1;
          const aTS = Date.parse(a.updatedAt);
          const bTS = Date.parse(b.updatedAt);
          const safeA = Number.isFinite(aTS) ? aTS : 0;
          const safeB = Number.isFinite(bTS) ? bTS : 0;
          if (safeA !== safeB) return safeB - safeA;
          return a.title.localeCompare(b.title);
        })
        .map((sessionItem) => ({
          id: sessionItem.id,
          title: sessionItem.title,
          pinned: Boolean(sessionItem.pinned),
          activeJobID: sessionItem.activeJobID,
          unreadDone: sessionItem.unreadDone,
          lastJobStatus: sessionItem.lastJobStatus,
          updatedAt: sessionItem.updatedAt,
        })),
    };

    group.projects.push(project);
    groups.set(hostID, group);
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    projects: group.projects.sort((a, b) => {
      const aPriority = projectPriority(a, activeWorkspaceID);
      const bPriority = projectPriority(b, activeWorkspaceID);
      if (aPriority !== bPriority) return aPriority - bPriority;

      const aUpdatedAtMS = projectUpdatedAtMS(a);
      const bUpdatedAtMS = projectUpdatedAtMS(b);
      if (aUpdatedAtMS !== bUpdatedAtMS) return bUpdatedAtMS - aUpdatedAtMS;

      const titleDiff = a.title.localeCompare(b.title);
      if (titleDiff !== 0) return titleDiff;
      return a.path.localeCompare(b.path);
    }),
  }));
}

export function filterSessionTreeHosts(
  sessionTreeHosts: SessionTreeHost[],
  projectFilter: string,
): SessionTreeHost[] {
  const query = projectFilter.trim().toLowerCase();
  if (!query) return sessionTreeHosts;
  const nextHosts: SessionTreeHost[] = [];
  for (const host of sessionTreeHosts) {
    const hostText = `${host.hostName} ${host.hostAddress}`.toLowerCase();
    if (hostText.includes(query)) {
      nextHosts.push(host);
      continue;
    }
    const projects: SessionTreeProject[] = [];
    for (const project of host.projects) {
      const projectText = `${project.title} ${project.path}`.toLowerCase();
      if (projectText.includes(query)) {
        projects.push(project);
        continue;
      }
      const sessions = project.sessions.filter((sessionItem) => {
        const text = `${sessionItem.title} ${sessionItem.id}`.toLowerCase();
        return text.includes(query);
      });
      if (sessions.length === 0) continue;
      projects.push({
        ...project,
        sessions,
      });
    }
    if (projects.length === 0) continue;
    nextHosts.push({
      ...host,
      projects,
    });
  }
  return nextHosts;
}

export function collectVisibleTreeSessionIDs(
  filteredSessionTreeHosts: SessionTreeHost[],
  collapsedHostIDs: string[],
): string[] {
  const out: string[] = [];
  for (const hostNode of filteredSessionTreeHosts) {
    if (collapsedHostIDs.includes(hostNode.hostID)) continue;
    for (const projectNode of hostNode.projects) {
      for (const sessionNode of projectNode.sessions) {
        out.push(sessionNode.id);
      }
    }
  }
  return out;
}

function projectPriority(
  project: SessionTreeProject,
  activeWorkspaceID: string,
): number {
  if (project.id === activeWorkspaceID) return 0;
  if (project.sessions.some((sessionItem) => sessionItem.activeJobID.trim() !== "")) {
    return 1;
  }
  if (project.sessions.some((sessionItem) => sessionItem.unreadDone)) {
    return 2;
  }
  return 3;
}

function projectUpdatedAtMS(project: SessionTreeProject): number {
  const parsedProjectTS = Date.parse(project.updatedAt);
  let latest = Number.isFinite(parsedProjectTS) ? parsedProjectTS : 0;
  for (const sessionItem of project.sessions) {
    const parsedSessionTS = Date.parse(sessionItem.updatedAt);
    if (Number.isFinite(parsedSessionTS)) {
      latest = Math.max(latest, parsedSessionTS);
    }
  }
  return latest;
}
