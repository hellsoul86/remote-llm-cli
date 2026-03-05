import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MutableRefObject,
  SetStateAction,
} from "react";

import type { Host } from "../../api";
import type { ConversationThread } from "../../domains/session";
import { DEFAULT_WORKSPACE_PATH } from "./config";
import type { SessionAlert } from "./types";

type CreateSessionUIActionsDeps = {
  createThread: () => void;
  promptInputRef: MutableRefObject<HTMLTextAreaElement | null>;
  activeThread: ConversationThread | null;
  addDirDraft: string;
  setAddDirDraft: Dispatch<SetStateAction<string>>;
  addThreadAddDir: (threadID: string, path: string) => void;
  configFlagDraft: string;
  setConfigFlagDraft: Dispatch<SetStateAction<string>>;
  addThreadConfigFlag: (threadID: string, value: string) => void;
  enableFlagDraft: string;
  setEnableFlagDraft: Dispatch<SetStateAction<string>>;
  addThreadEnableFlag: (threadID: string, value: string) => void;
  disableFlagDraft: string;
  setDisableFlagDraft: Dispatch<SetStateAction<string>>;
  addThreadDisableFlag: (threadID: string, value: string) => void;
  activeWorkspaceHostID: string;
  activeWorkspacePath: string;
  hosts: Host[];
  setProjectComposerOpen: Dispatch<SetStateAction<boolean>>;
  setProjectFormHostID: Dispatch<SetStateAction<string>>;
  setProjectFormPath: Dispatch<SetStateAction<string>>;
  setProjectFormTitle: Dispatch<SetStateAction<string>>;
  sessionButtonRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
  visibleTreeSessionIDs: string[];
  treeCursorSessionID: string;
  setTreeCursorSessionID: Dispatch<SetStateAction<string>>;
  activateThread: (threadID: string) => void;
  setThreadPinned: (threadID: string, pinned: boolean) => void;
  setCollapsedHostIDs: Dispatch<SetStateAction<string[]>>;
  threadWorkspaceMap: Map<string, string>;
  switchMode: (mode: "session" | "ops") => void;
  dismissSessionAlert: (id: string) => void;
};

export function createSessionUIActions(deps: CreateSessionUIActionsDeps) {
  const focusComposerSoon = () => {
    window.requestAnimationFrame(() => {
      deps.promptInputRef.current?.focus();
    });
  };

  const createThreadAndFocus = () => {
    deps.createThread();
    focusComposerSoon();
  };

  const onAddDirDraftSubmit = () => {
    if (!deps.activeThread) return;
    const trimmed = deps.addDirDraft.trim();
    if (!trimmed) return;
    deps.addThreadAddDir(deps.activeThread.id, trimmed);
    deps.setAddDirDraft("");
  };

  const onConfigFlagDraftSubmit = () => {
    if (!deps.activeThread) return;
    const trimmed = deps.configFlagDraft.trim();
    if (!trimmed) return;
    deps.addThreadConfigFlag(deps.activeThread.id, trimmed);
    deps.setConfigFlagDraft("");
  };

  const onEnableFlagDraftSubmit = () => {
    if (!deps.activeThread) return;
    const trimmed = deps.enableFlagDraft.trim();
    if (!trimmed) return;
    deps.addThreadEnableFlag(deps.activeThread.id, trimmed);
    deps.setEnableFlagDraft("");
  };

  const onDisableFlagDraftSubmit = () => {
    if (!deps.activeThread) return;
    const trimmed = deps.disableFlagDraft.trim();
    if (!trimmed) return;
    deps.addThreadDisableFlag(deps.activeThread.id, trimmed);
    deps.setDisableFlagDraft("");
  };

  const openProjectComposer = () => {
    const fallbackHostID = deps.activeWorkspaceHostID || deps.hosts[0]?.id || "";
    const fallbackPath = deps.activeWorkspacePath || DEFAULT_WORKSPACE_PATH;
    deps.setProjectComposerOpen(true);
    deps.setProjectFormHostID(fallbackHostID);
    deps.setProjectFormPath(fallbackPath);
    deps.setProjectFormTitle("");
  };

  const closeProjectComposer = () => {
    deps.setProjectComposerOpen(false);
    deps.setProjectFormTitle("");
  };

  const registerSessionButtonRef = (
    sessionID: string,
    node: HTMLButtonElement | null,
  ) => {
    if (!sessionID) return;
    if (node) {
      deps.sessionButtonRefs.current.set(sessionID, node);
      return;
    }
    deps.sessionButtonRefs.current.delete(sessionID);
  };

  const moveTreeCursor = (step: number) => {
    if (deps.visibleTreeSessionIDs.length === 0) return;
    const currentIndex = Math.max(
      0,
      deps.visibleTreeSessionIDs.findIndex((id) => id === deps.treeCursorSessionID),
    );
    const nextIndex =
      (currentIndex + step + deps.visibleTreeSessionIDs.length) %
      deps.visibleTreeSessionIDs.length;
    const nextID = deps.visibleTreeSessionIDs[nextIndex];
    deps.setTreeCursorSessionID(nextID);
    const node = deps.sessionButtonRefs.current.get(nextID);
    node?.focus();
  };

  const onSessionTreeKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    sessionID: string,
    pinned: boolean,
  ) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveTreeCursor(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveTreeCursor(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      const nextID = deps.visibleTreeSessionIDs[0];
      if (!nextID) return;
      deps.setTreeCursorSessionID(nextID);
      deps.sessionButtonRefs.current.get(nextID)?.focus();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const nextID =
        deps.visibleTreeSessionIDs[deps.visibleTreeSessionIDs.length - 1];
      if (!nextID) return;
      deps.setTreeCursorSessionID(nextID);
      deps.sessionButtonRefs.current.get(nextID)?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      deps.setTreeCursorSessionID(sessionID);
      deps.activateThread(sessionID);
      focusComposerSoon();
      return;
    }
    if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      deps.setThreadPinned(sessionID, !pinned);
    }
  };

  const toggleHostCollapsed = (hostID: string) => {
    deps.setCollapsedHostIDs((prev) =>
      prev.includes(hostID)
        ? prev.filter((id) => id !== hostID)
        : [...prev, hostID],
    );
  };

  const openSessionFromAlert = (alert: SessionAlert) => {
    if (deps.threadWorkspaceMap.has(alert.threadID)) {
      deps.activateThread(alert.threadID);
      deps.switchMode("session");
      focusComposerSoon();
    }
    deps.dismissSessionAlert(alert.id);
  };

  return {
    createThreadAndFocus,
    focusComposerSoon,
    onAddDirDraftSubmit,
    onConfigFlagDraftSubmit,
    onEnableFlagDraftSubmit,
    onDisableFlagDraftSubmit,
    openProjectComposer,
    closeProjectComposer,
    registerSessionButtonRef,
    onSessionTreeKeyDown,
    toggleHostCollapsed,
    openSessionFromAlert,
  };
}
