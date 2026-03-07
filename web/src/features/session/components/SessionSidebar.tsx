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
  collapsedHostIDs: _collapsedHostIDs,
  onToggleHostCollapsed: _onToggleHostCollapsed,
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
  const projectCount = sessionTreeHosts.reduce(
    (sum, hostNode) => sum + hostNode.projects.length,
    0,
  );
  const showHostPicker = hosts.length > 1;
  const showHostPill = (hostName: string) =>
    sessionTreeHosts.length > 1 || hostName.trim() !== "local-default";
  const visibleProjects = filteredSessionTreeHosts.flatMap((hostNode) =>
    hostNode.projects.map((projectNode) => ({
      hostName: hostNode.hostName,
      hostAddress: hostNode.hostAddress,
      projectNode,
    })),
  );

  return (
    <aside className="session-side codex-sidebar">
      {projectComposerOpen ? (
        <>
          <button
            type="button"
            className="project-create-backdrop"
            aria-label="Close project creator"
            onClick={onCloseProjectComposer}
          />
          <section
            className="project-create-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-create-title"
          >
            <div className="project-create-sheet-head">
              <div>
                <p className="pane-subtle-light pane-summary-copy">new project</p>
                <h4 id="project-create-title">Create project</h4>
              </div>
              <button
                type="button"
                className="ghost rail-action-btn"
                onClick={onCloseProjectComposer}
                disabled={upsertingProjectID !== ""}
              >
                Close
              </button>
            </div>
            <form className="project-create-form" onSubmit={onCreateProject}>
              {showHostPicker ? (
                <label className="project-create-field">
                  <span>Host</span>
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
              ) : null}
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
          </section>
        </>
      ) : null}

      <section className="inspect-block focus-block">
        <div className="pane-title-line">
          <div className="pane-title-copy">
            <h3>Projects</h3>
            <p className="pane-subtle-light pane-summary-copy">
              {projectCount} project{projectCount === 1 ? "" : "s"} · recent threads
            </p>
          </div>
          <div className="pane-title-actions">
            <button
              type="button"
              className="ghost rail-action-btn"
              aria-label="New Project"
              onClick={onOpenProjectComposer}
            >
              + Project
            </button>
            <button
              type="button"
              className="ghost rail-action-btn"
              aria-label="New Session"
              onClick={onCreateThread}
            >
              + Thread
            </button>
          </div>
        </div>
        <p className="pane-subtle-light sidebar-command-hint">
          Cmd/Ctrl+B sidebar · Cmd/Ctrl+K palette
        </p>
        <label className="tree-filter">
          <input
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            placeholder="Search projects or threads"
          />
        </label>

        <div className="project-tree">
          {sessionTreeHosts.length === 0 ? (
            <p className="pane-subtle-light">No projects discovered yet.</p>
          ) : visibleProjects.length === 0 ? (
            <p className="pane-subtle-light">No matching projects or threads.</p>
          ) : (
            visibleProjects.map(({ hostName, hostAddress, projectNode }) => (
              <article
                key={`${hostName}:${projectNode.id}`}
                className={`project-node ${
                  projectNode.id === activeWorkspaceID ? "project-node-active" : ""
                }`}
              >
                <button
                  type="button"
                  className={`project-chip ${
                    projectNode.id === activeWorkspaceID ? "active" : ""
                  }`}
                  onClick={() => {
                    onSelectWorkspace(projectNode.id);
                    onFocusComposer();
                  }}
                  title={hostAddress ? `${projectNode.path} · ${hostAddress}` : projectNode.path}
                >
                  <span className="project-chip-main">
                    <strong>{projectNode.title}</strong>
                    <em>{projectNode.path}</em>
                  </span>
                  <span className="project-chip-side">
                    {showHostPill(hostName) ? (
                      <small className="project-host-pill" title={hostAddress || hostName}>
                        {hostName}
                      </small>
                    ) : null}
                    <small>
                      {projectNode.sessions.length === 0
                        ? "empty"
                        : `${projectNode.sessions.length}`}
                    </small>
                  </span>
                </button>
                {projectNode.id === activeWorkspaceID ? (
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
                ) : null}
                <div className="project-session-list">
                  {projectNode.sessions.length === 0 ? (
                    <p className="pane-subtle-light compact-empty">
                      No threads in this project.
                    </p>
                  ) : (
                    projectNode.sessions.map((sessionNode) => (
                      <button
                        key={sessionNode.id}
                        type="button"
                        ref={(node) => registerSessionButtonRef(sessionNode.id, node)}
                        className={`session-chip-tree ${
                          sessionNode.id === activeThreadID ? "active" : ""
                        }`}
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
              </article>
            ))
          )}
        </div>
      </section>

      <section className="inspect-block compact-session-meta">
        <div className="sidebar-meta-head">
          <strong>Activity</strong>
          <div className="sidebar-meta-actions">
            <button
              type="button"
              className="ghost sidebar-meta-btn"
              onClick={onEnableNotifications}
            >
              {notificationPermission === "granted" ? "Alerts on" : "Enable alerts"}
            </button>
            <button
              type="button"
              className="ghost sidebar-meta-btn"
              onClick={onToggleAlertsExpanded}
              disabled={sessionAlerts.length === 0}
            >
              Recent {sessionAlerts.length > 0 ? `(${sessionAlerts.length})` : ""}
            </button>
          </div>
        </div>
        <p className="pane-subtle-light sidebar-command-hint">
          Ctrl/Cmd+Shift+N new thread · P pin thread
        </p>
        {sessionAlerts.length === 0 ? (
          <p className="pane-subtle-light">No recent completions.</p>
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
        ) : (
          <p className="pane-subtle-light">
            Recent completions stay tucked away until you need them.
          </p>
        )}
      </section>
    </aside>
  );
}
