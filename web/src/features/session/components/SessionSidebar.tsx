import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  type SessionAlert,
  type SessionTreeHost,
  type SessionTreeProject,
} from "../types";

type HostOption = {
  id: string;
  name: string;
};

type SessionSidebarProps = {
  authReady: boolean;
  hasToken: boolean;
  hosts: HostOption[];
  projectComposerOpen: boolean;
  onOpenProjectComposer: () => void;
  onCreateThread: () => void;
  onCreateProject: (event: FormEvent<HTMLFormElement>) => void;
  projectFormHostID: string;
  setProjectFormHostID: (value: string) => void;
  projectFormPath: string;
  setProjectFormPath: (value: string) => void;
  projectFormTitle: string;
  setProjectFormTitle: (value: string) => void;
  upsertingProjectID: string;
  onCloseProjectComposer: () => void;
  projectFilter: string;
  setProjectFilter: (value: string) => void;
  sessionTreeHosts: SessionTreeHost[];
  filteredSessionTreeHosts: SessionTreeHost[];
  collapsedHostIDs: string[];
  onToggleHostCollapsed: (hostID: string) => void;
  activeWorkspaceID: string;
  onSelectWorkspace: (workspaceID: string) => void;
  onFocusComposer: () => void;
  onRenameProject: (project: SessionTreeProject) => void;
  onArchiveProject: (
    projectID: string,
    hostID: string,
    path: string,
    sessionCount: number,
  ) => void;
  deletingProjectID: string;
  registerSessionButtonRef: (
    sessionID: string,
    node: HTMLButtonElement | null,
  ) => void;
  activeThreadID: string;
  treeCursorSessionID: string;
  setTreeCursorSessionID: (sessionID: string) => void;
  onActivateThread: (sessionID: string) => void;
  onSetThreadPinned: (sessionID: string, pinned: boolean) => void;
  onSessionTreeKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    sessionID: string,
    pinned: boolean,
  ) => void;
  notificationPermission: NotificationPermission;
  onEnableNotifications: () => void;
  onToggleAlertsExpanded: () => void;
  sessionAlertsExpanded: boolean;
  sessionAlerts: SessionAlert[];
  onClearSessionAlerts: () => void;
  onOpenSessionFromAlert: (alert: SessionAlert) => void;
};

export function SessionSidebar({
  authReady,
  hasToken,
  hosts,
  projectComposerOpen,
  onOpenProjectComposer,
  onCreateThread,
  onCreateProject,
  projectFormHostID,
  setProjectFormHostID,
  projectFormPath,
  setProjectFormPath,
  projectFormTitle,
  setProjectFormTitle,
  upsertingProjectID,
  onCloseProjectComposer,
  projectFilter,
  setProjectFilter,
  sessionTreeHosts,
  filteredSessionTreeHosts,
  collapsedHostIDs,
  onToggleHostCollapsed,
  activeWorkspaceID,
  onSelectWorkspace,
  onFocusComposer,
  onRenameProject,
  onArchiveProject,
  deletingProjectID,
  registerSessionButtonRef,
  activeThreadID,
  treeCursorSessionID,
  setTreeCursorSessionID,
  onActivateThread,
  onSetThreadPinned,
  onSessionTreeKeyDown,
  notificationPermission,
  onEnableNotifications,
  onToggleAlertsExpanded,
  sessionAlertsExpanded,
  sessionAlerts,
  onClearSessionAlerts,
  onOpenSessionFromAlert,
}: SessionSidebarProps) {
  return (
    <aside className="session-side codex-sidebar">
      <section className="inspect-block focus-block">
        <div className="pane-title-line">
          <div className="pane-title-copy">
            <h3>Projects</h3>
            <p className="pane-subtle-light">
              Servers, project paths, and session history.
            </p>
          </div>
          <div className="pane-title-actions">
            <button
              type="button"
              className="ghost new-thread"
              onClick={onOpenProjectComposer}
            >
              New Project
            </button>
            <button
              type="button"
              className="ghost new-thread"
              onClick={onCreateThread}
            >
              New Session
            </button>
          </div>
        </div>
        {projectComposerOpen ? (
          <form className="project-create-form" onSubmit={onCreateProject}>
            <label className="project-create-field">
              <span>Server</span>
              <select
                value={projectFormHostID}
                onChange={(event) => setProjectFormHostID(event.target.value)}
                disabled={!authReady || !hasToken || upsertingProjectID !== ""}
              >
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="project-create-field">
              <span>Path</span>
              <input
                placeholder="/path/to/project"
                value={projectFormPath}
                onChange={(event) => setProjectFormPath(event.target.value)}
                disabled={!authReady || !hasToken || upsertingProjectID !== ""}
              />
            </label>
            <label className="project-create-field">
              <span>Name</span>
              <input
                placeholder="My Project"
                value={projectFormTitle}
                onChange={(event) => setProjectFormTitle(event.target.value)}
                disabled={!authReady || !hasToken || upsertingProjectID !== ""}
              />
            </label>
            <div className="project-create-actions">
              <button
                type="submit"
                disabled={
                  !authReady ||
                  !hasToken ||
                  upsertingProjectID !== "" ||
                  !projectFormHostID.trim() ||
                  !projectFormPath.trim()
                }
              >
                {upsertingProjectID === "__create__" ? "Creating..." : "Create"}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={onCloseProjectComposer}
                disabled={upsertingProjectID !== ""}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        <label className="tree-filter">
          <input
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            placeholder="Filter projects or sessions"
          />
        </label>

        <div className="project-tree">
          {sessionTreeHosts.length === 0 ? (
            <p className="pane-subtle-light">No servers/projects discovered yet.</p>
          ) : filteredSessionTreeHosts.length === 0 ? (
            <p className="pane-subtle-light">No matching projects or sessions.</p>
          ) : (
            filteredSessionTreeHosts.map((hostNode) => {
              const isCollapsed = collapsedHostIDs.includes(hostNode.hostID);
              return (
                <article key={hostNode.hostID} className="project-host-group">
                  <header className="project-host-head">
                    <div className="project-host-headline">
                      <strong>{hostNode.hostName}</strong>
                      {hostNode.hostAddress ? <small>{hostNode.hostAddress}</small> : null}
                    </div>
                    <button
                      type="button"
                      className="ghost host-toggle"
                      onClick={() => onToggleHostCollapsed(hostNode.hostID)}
                    >
                      {isCollapsed ? "Expand" : "Collapse"}
                    </button>
                  </header>
                  {isCollapsed ? null : hostNode.projects.length === 0 ? (
                    <p className="pane-subtle-light compact-empty">No projects available.</p>
                  ) : (
                    hostNode.projects.map((projectNode) => (
                      <div key={projectNode.id} className="project-node">
                        <button
                          type="button"
                          className={`project-chip ${projectNode.id === activeWorkspaceID ? "active" : ""}`}
                          onClick={() => {
                            onSelectWorkspace(projectNode.id);
                            onFocusComposer();
                          }}
                          title={projectNode.path}
                        >
                          <span className="project-chip-main">
                            <strong>{projectNode.title}</strong>
                            <em>{projectNode.path}</em>
                          </span>
                          <small>
                            {projectNode.sessions.length === 0
                              ? "empty"
                              : `${projectNode.sessions.length}`}
                          </small>
                        </button>
                        <div className="project-node-actions">
                          <button
                            type="button"
                            className="ghost project-archive-btn"
                            disabled={!authReady || !hasToken || upsertingProjectID !== ""}
                            onClick={() => onRenameProject(projectNode)}
                          >
                            {upsertingProjectID === projectNode.id ? "Saving..." : "Rename"}
                          </button>
                          <button
                            type="button"
                            className="ghost danger-ghost project-archive-btn"
                            disabled={
                              !authReady ||
                              !hasToken ||
                              upsertingProjectID !== "" ||
                              deletingProjectID === projectNode.id ||
                              deletingProjectID !== ""
                            }
                            title="Archive project (empty only)"
                            onClick={() =>
                              onArchiveProject(
                                projectNode.id,
                                projectNode.hostID,
                                projectNode.path,
                                projectNode.sessions.length,
                              )
                            }
                          >
                            {deletingProjectID === projectNode.id ? "Archiving..." : "Archive"}
                          </button>
                        </div>
                        <div className="project-session-list">
                          {projectNode.sessions.length === 0 ? (
                            <p className="pane-subtle-light compact-empty">
                              No sessions in this project.
                            </p>
                          ) : (
                            projectNode.sessions.map((sessionNode) => (
                              <button
                                key={sessionNode.id}
                                type="button"
                                ref={(node) => registerSessionButtonRef(sessionNode.id, node)}
                                className={`session-chip-tree ${sessionNode.id === activeThreadID ? "active" : ""}`}
                                data-session-id={sessionNode.id}
                                data-pinned={sessionNode.pinned ? "true" : "false"}
                                tabIndex={treeCursorSessionID === sessionNode.id ? 0 : -1}
                                onClick={(event) => {
                                  if (event.metaKey || event.ctrlKey) {
                                    event.preventDefault();
                                    onSetThreadPinned(sessionNode.id, !sessionNode.pinned);
                                    return;
                                  }
                                  setTreeCursorSessionID(sessionNode.id);
                                  onActivateThread(sessionNode.id);
                                  onFocusComposer();
                                }}
                                onFocus={() => setTreeCursorSessionID(sessionNode.id)}
                                onKeyDown={(event) =>
                                  onSessionTreeKeyDown(
                                    event,
                                    sessionNode.id,
                                    sessionNode.pinned,
                                  )
                                }
                                title={sessionNode.title}
                              >
                                <span className="session-chip-label">{sessionNode.title}</span>
                                <span className="session-chip-state">
                                  {sessionNode.pinned ? (
                                    <small className="session-chip-badge pinned">pin</small>
                                  ) : null}
                                  {sessionNode.activeJobID ? (
                                    <small className="session-chip-badge running">running</small>
                                  ) : null}
                                  {sessionNode.unreadDone ? (
                                    <small className="session-chip-badge unread">new</small>
                                  ) : null}
                                  {!sessionNode.activeJobID &&
                                  !sessionNode.unreadDone &&
                                  sessionNode.lastJobStatus !== "idle" ? (
                                    <small className="session-chip-badge status">
                                      {sessionNode.lastJobStatus}
                                    </small>
                                  ) : null}
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </article>
              );
            })
          )}
        </div>
      </section>

      <section className="inspect-block compact-session-meta">
        <div className="shortcut-stack">
          <p className="pane-subtle-light">
            Ctrl/Cmd+K command palette · Enter send · Shift+Enter newline
          </p>
          <p className="pane-subtle-light">
            Ctrl/Cmd+Shift+N new session · P pin focused session
          </p>
        </div>
        <div className="ops-actions-row">
          <button type="button" className="ghost" onClick={onEnableNotifications}>
            Alerts: {notificationPermission}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={onToggleAlertsExpanded}
            disabled={sessionAlerts.length === 0}
          >
            Notifications {sessionAlerts.length > 0 ? `(${sessionAlerts.length})` : ""}
          </button>
        </div>
        {sessionAlerts.length === 0 ? (
          <p className="pane-subtle-light">No notifications yet.</p>
        ) : sessionAlertsExpanded ? (
          <div className="notification-center">
            <div className="notification-head">
              <strong>Recent</strong>
              <button type="button" className="ghost" onClick={onClearSessionAlerts}>
                Clear
              </button>
            </div>
            <div className="notification-list" role="status" aria-live="polite">
              {sessionAlerts
                .slice(Math.max(0, sessionAlerts.length - 8))
                .reverse()
                .map((alert) => (
                  <button
                    key={alert.id}
                    type="button"
                    className="session-alert"
                    onClick={() => onOpenSessionFromAlert(alert)}
                  >
                    <strong>{alert.title}</strong>
                    <span>{alert.body}</span>
                  </button>
                ))}
            </div>
          </div>
        ) : null}
      </section>
    </aside>
  );
}
