import {
  type Host,
  type ProjectRecord,
  type SessionRecord,
} from "../../api";
import { resolveProjectTitle } from "./utils";

export type ProjectSyncSession = { id: string; title: string; updatedAt?: string };

export type ProjectSyncProject = {
  id?: string;
  hostID: string;
  hostName: string;
  path: string;
  title: string;
  sessions: ProjectSyncSession[];
};

export function buildDiscoveredProjects(
  sourceHosts: Host[],
  targets: Array<{
    host: Host;
    ok: boolean;
    sessions?: Array<{
      session_id: string;
      cwd?: string;
      thread_name?: string;
      updated_at: string;
    }>;
  }>,
  defaultWorkspacePath: string,
): ProjectSyncProject[] {
  const hostMap = new Map<string, Host>();
  for (const host of sourceHosts) hostMap.set(host.id, host);

  const grouped = new Map<string, Map<string, ProjectSyncSession[]>>();
  for (const target of targets) {
    const hostID = target.host?.id?.trim();
    if (!hostID) continue;
    if (!grouped.has(hostID)) grouped.set(hostID, new Map());
    const pathMap = grouped.get(hostID)!;
    const sessions = Array.isArray(target.sessions) ? target.sessions : [];
    for (const sessionItem of sessions) {
      const projectPath =
        sessionItem.cwd?.trim() ||
        target.host.workspace?.trim() ||
        hostMap.get(hostID)?.workspace?.trim() ||
        defaultWorkspacePath;
      if (!pathMap.has(projectPath)) pathMap.set(projectPath, []);
      pathMap.get(projectPath)!.push({
        id: sessionItem.session_id,
        title: sessionItem.thread_name?.trim() || sessionItem.session_id,
        updatedAt: sessionItem.updated_at,
      });
    }
    if (sessions.length === 0) {
      const fallbackPath =
        target.host.workspace?.trim() || hostMap.get(hostID)?.workspace?.trim();
      if (fallbackPath && !pathMap.has(fallbackPath)) {
        pathMap.set(fallbackPath, []);
      }
    }
  }

  const projects: ProjectSyncProject[] = [];
  for (const [hostID, pathMap] of grouped.entries()) {
    const host = hostMap.get(hostID);
    const hostName = host?.name ?? hostID;
    for (const [projectPath, sessions] of pathMap.entries()) {
      const orderedSessions = [...sessions].sort((a, b) => {
        const left = a.updatedAt ?? "";
        const right = b.updatedAt ?? "";
        if (left === right) return a.title.localeCompare(b.title);
        return left > right ? -1 : 1;
      });
      projects.push({
        hostID,
        hostName,
        path: projectPath,
        title: resolveProjectTitle(projectPath),
        sessions: orderedSessions,
      });
    }
  }

  if (projects.length > 0) return projects;

  return sourceHosts.map((host) => ({
    hostID: host.id,
    hostName: host.name,
    path: host.workspace?.trim() || defaultWorkspacePath,
    title: resolveProjectTitle(host.workspace?.trim() || defaultWorkspacePath),
    sessions: [],
  }));
}

export function buildProjectsFromRecords(
  sourceHosts: Host[],
  projects: ProjectRecord[],
  sessions: SessionRecord[],
  defaultWorkspacePath: string,
): ProjectSyncProject[] {
  const hostMap = new Map<string, Host>();
  for (const host of sourceHosts) {
    hostMap.set(host.id, host);
  }

  const projectKeyByID = new Map<string, string>();
  const grouped = new Map<
    string,
    {
      projectID: string;
      hostID: string;
      hostName: string;
      path: string;
      title: string;
      sessions: ProjectSyncSession[];
    }
  >();
  const sessionSeenByProjectKey = new Map<string, Set<string>>();

  const ensureProjectBucket = (
    hostIDRaw: string,
    hostNameRaw: string,
    pathRaw: string,
    titleRaw?: string,
    projectIDRaw?: string,
  ) => {
    const hostID = hostIDRaw.trim();
    const path = pathRaw.trim();
    if (!hostID || !path) return "";
    if (sourceHosts.length > 0 && !hostMap.has(hostID)) return "";
    const key = `${hostID}::${path}`;
    const resolvedTitle = resolveProjectTitle(path, titleRaw);
    const projectID = projectIDRaw?.trim() ?? "";
    if (!grouped.has(key)) {
      const host = hostMap.get(hostID);
      grouped.set(key, {
        projectID,
        hostID,
        hostName: hostNameRaw.trim() || host?.name || hostID,
        path,
        title: resolvedTitle,
        sessions: [],
      });
    } else if (titleRaw?.trim()) {
      const current = grouped.get(key);
      if (current && current.title.trim() !== titleRaw.trim()) {
        current.title = resolvedTitle;
      }
      if (current && !current.projectID && projectID) {
        current.projectID = projectID;
      }
    } else {
      const current = grouped.get(key);
      if (current && !current.projectID && projectID) {
        current.projectID = projectID;
      }
    }
    if (!sessionSeenByProjectKey.has(key)) {
      sessionSeenByProjectKey.set(key, new Set<string>());
    }
    return key;
  };

  for (const project of projects) {
    const key = ensureProjectBucket(
      project.host_id,
      project.host_name ?? "",
      project.path,
      project.title,
      project.id,
    );
    if (!key) continue;
    projectKeyByID.set(project.id, key);
  }

  for (const sessionRecord of sessions) {
    const sessionID = sessionRecord.id.trim();
    if (!sessionID) continue;
    const fromProjectID = projectKeyByID.get(sessionRecord.project_id.trim()) ?? "";
    const fallbackHostID = sessionRecord.host_id.trim();
    const fallbackPath = sessionRecord.path.trim();
    const fallbackHostName = hostMap.get(fallbackHostID)?.name ?? fallbackHostID;
    const key =
      fromProjectID ||
      ensureProjectBucket(fallbackHostID, fallbackHostName, fallbackPath);
    if (!key) continue;
    const bucket = grouped.get(key);
    const seen = sessionSeenByProjectKey.get(key);
    if (!bucket || !seen || seen.has(sessionID)) continue;
    seen.add(sessionID);
    bucket.sessions.push({
      id: sessionID,
      title: sessionRecord.title?.trim() || sessionID,
      updatedAt: sessionRecord.updated_at,
    });
  }

  for (const bucket of grouped.values()) {
    bucket.sessions.sort((a, b) => {
      const left = a.updatedAt ?? "";
      const right = b.updatedAt ?? "";
      if (left === right) return a.title.localeCompare(b.title);
      return left > right ? -1 : 1;
    });
  }

  const byHost = new Set<string>();
  for (const bucket of grouped.values()) {
    byHost.add(bucket.hostID);
  }
  for (const host of sourceHosts) {
    if (byHost.has(host.id)) continue;
    ensureProjectBucket(
      host.id,
      host.name,
      host.workspace?.trim() || defaultWorkspacePath,
      "",
      "",
    );
  }

  return Array.from(grouped.values()).map((project) => ({
    id: project.projectID || undefined,
    hostID: project.hostID,
    hostName: project.hostName,
    path: project.path,
    title: project.title,
    sessions: project.sessions,
  }));
}
