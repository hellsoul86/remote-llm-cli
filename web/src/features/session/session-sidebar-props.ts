import type {
  ComponentProps,
  Dispatch,
  SetStateAction,
} from "react";

import type { SessionTreeProject } from "./types";
import { SessionSidebar } from "./components/SessionSidebar";

type SessionSidebarProps = ComponentProps<typeof SessionSidebar>;

type BuildSessionSidebarPropsDeps = Pick<
  SessionSidebarProps,
  | "authReady"
  | "hasToken"
  | "hosts"
  | "projectComposerOpen"
  | "onOpenProjectComposer"
  | "onCreateThread"
  | "onCreateProject"
  | "projectFormHostID"
  | "setProjectFormHostID"
  | "projectFormPath"
  | "setProjectFormPath"
  | "projectFormTitle"
  | "setProjectFormTitle"
  | "upsertingProjectID"
  | "onCloseProjectComposer"
  | "projectFilter"
  | "setProjectFilter"
  | "sessionTreeHosts"
  | "filteredSessionTreeHosts"
  | "collapsedHostIDs"
  | "onToggleHostCollapsed"
  | "activeWorkspaceID"
  | "onSelectWorkspace"
  | "onFocusComposer"
  | "deletingProjectID"
  | "registerSessionButtonRef"
  | "activeThreadID"
  | "treeCursorSessionID"
  | "setTreeCursorSessionID"
  | "onActivateThread"
  | "onSetThreadPinned"
  | "onSessionTreeKeyDown"
  | "notificationPermission"
  | "sessionAlertsExpanded"
  | "sessionAlerts"
  | "onClearSessionAlerts"
  | "onOpenSessionFromAlert"
> & {
  onRenameProjectAsync: (project: SessionTreeProject) => Promise<void>;
  onArchiveProjectAsync: (
    projectID: string,
    hostID: string,
    path: string,
    sessionCount: number,
  ) => Promise<void>;
  onEnableNotificationsAsync: () => Promise<void>;
  setSessionAlertsExpanded: Dispatch<SetStateAction<boolean>>;
};

export function buildSessionSidebarProps(
  deps: BuildSessionSidebarPropsDeps,
): SessionSidebarProps {
  return {
    authReady: deps.authReady,
    hasToken: deps.hasToken,
    hosts: deps.hosts,
    projectComposerOpen: deps.projectComposerOpen,
    onOpenProjectComposer: deps.onOpenProjectComposer,
    onCreateThread: deps.onCreateThread,
    onCreateProject: deps.onCreateProject,
    projectFormHostID: deps.projectFormHostID,
    setProjectFormHostID: deps.setProjectFormHostID,
    projectFormPath: deps.projectFormPath,
    setProjectFormPath: deps.setProjectFormPath,
    projectFormTitle: deps.projectFormTitle,
    setProjectFormTitle: deps.setProjectFormTitle,
    upsertingProjectID: deps.upsertingProjectID,
    onCloseProjectComposer: deps.onCloseProjectComposer,
    projectFilter: deps.projectFilter,
    setProjectFilter: deps.setProjectFilter,
    sessionTreeHosts: deps.sessionTreeHosts,
    filteredSessionTreeHosts: deps.filteredSessionTreeHosts,
    collapsedHostIDs: deps.collapsedHostIDs,
    onToggleHostCollapsed: deps.onToggleHostCollapsed,
    activeWorkspaceID: deps.activeWorkspaceID,
    onSelectWorkspace: deps.onSelectWorkspace,
    onFocusComposer: deps.onFocusComposer,
    onRenameProject: (projectNode) => {
      void deps.onRenameProjectAsync(projectNode);
    },
    onArchiveProject: (projectID, hostID, path, sessionCount) => {
      void deps.onArchiveProjectAsync(projectID, hostID, path, sessionCount);
    },
    deletingProjectID: deps.deletingProjectID,
    registerSessionButtonRef: deps.registerSessionButtonRef,
    activeThreadID: deps.activeThreadID,
    treeCursorSessionID: deps.treeCursorSessionID,
    setTreeCursorSessionID: deps.setTreeCursorSessionID,
    onActivateThread: deps.onActivateThread,
    onSetThreadPinned: deps.onSetThreadPinned,
    onSessionTreeKeyDown: deps.onSessionTreeKeyDown,
    notificationPermission: deps.notificationPermission,
    onEnableNotifications: () => {
      void deps.onEnableNotificationsAsync();
    },
    onToggleAlertsExpanded: () => {
      deps.setSessionAlertsExpanded((prev) => !prev);
    },
    sessionAlertsExpanded: deps.sessionAlertsExpanded,
    sessionAlerts: deps.sessionAlerts,
    onClearSessionAlerts: deps.onClearSessionAlerts,
    onOpenSessionFromAlert: deps.onOpenSessionFromAlert,
  };
}
