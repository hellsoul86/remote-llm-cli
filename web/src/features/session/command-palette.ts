import { type ConversationThread, type WorkspaceDirectory } from "../../domains/session";
import { resolveProjectTitle } from "./utils";

export type CommandPaletteAction = {
  id: string;
  label: string;
  detail: string;
  searchText: string;
  run: () => void;
};

type BuildSessionCommandPaletteActionsInput = {
  activeWorkspaceTitle: string;
  threadsLength: number;
  activeThreadID: string;
  activeThread: ConversationThread | null;
  activeThreadBusy: boolean;
  workspaces: WorkspaceDirectory[];
  sessionModelChoices: string[];
  sessionModelDefault: string;
  onFocusComposer: () => void;
  onCreateSession: () => void;
  onSwitchPrevSession: () => void;
  onSwitchNextSession: () => void;
  onForkSession: () => void;
  onTogglePinSession: (sessionID: string, pinned: boolean) => void;
  onArchiveSession: () => void;
  onReconnectStream: () => void;
  onOpenProject: (workspaceID: string, preferredSessionID: string) => void;
  onSetModel: (sessionID: string, modelName: string) => void;
};

export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSessionCommandPaletteActions(
  input: BuildSessionCommandPaletteActionsInput,
): CommandPaletteAction[] {
  const actions: CommandPaletteAction[] = [];
  const pushAction = (
    id: string,
    label: string,
    detail: string,
    extraSearch: string,
    run: () => void,
  ) => {
    actions.push({
      id,
      label,
      detail,
      searchText: normalizeSearchText(`${label} ${detail} ${extraSearch}`),
      run,
    });
  };

  pushAction(
    "composer:focus",
    "Focus Prompt",
    "Cursor to composer",
    "focus prompt composer input",
    input.onFocusComposer,
  );
  pushAction(
    "session:new",
    "New Session",
    input.activeWorkspaceTitle || "current project",
    "create add session",
    input.onCreateSession,
  );

  if (input.threadsLength > 1) {
    pushAction(
      "session:previous",
      "Previous Session",
      "Switch to previous",
      "session prev",
      input.onSwitchPrevSession,
    );
    pushAction(
      "session:next",
      "Next Session",
      "Switch to next",
      "session next",
      input.onSwitchNextSession,
    );
  }

  if (input.activeThreadID.trim()) {
    pushAction(
      "session:fork",
      "Fork Session",
      input.activeThread?.title || "current session",
      "fork branch duplicate session",
      input.onForkSession,
    );
    pushAction(
      "session:pin",
      input.activeThread?.pinned ? "Unpin Session" : "Pin Session",
      input.activeThread?.title || "current session",
      "pin favorite",
      () => {
        if (!input.activeThread) return;
        input.onTogglePinSession(
          input.activeThread.id,
          !input.activeThread.pinned,
        );
      },
    );
    if (!input.activeThreadBusy) {
      pushAction(
        "session:archive",
        "Archive Session",
        input.activeThread?.title || "current session",
        "delete remove archive",
        input.onArchiveSession,
      );
    }
    pushAction(
      "session:reconnect",
      "Reconnect Stream",
      input.activeThread?.title || "current session",
      "stream reconnect",
      input.onReconnectStream,
    );
  }

  for (const workspace of input.workspaces) {
    const projectTitle = resolveProjectTitle(workspace.path, workspace.title);
    pushAction(
      `project:${workspace.id}`,
      `Open Project: ${projectTitle}`,
      `${workspace.hostName} · ${workspace.path}`,
      "project workspace directory",
      () => {
        input.onOpenProject(workspace.id, workspace.activeSessionID.trim());
      },
    );
  }

  if (input.activeThread) {
    for (const modelName of input.sessionModelChoices) {
      const modelDetail =
        modelName === input.sessionModelDefault
          ? `${modelName} (default)`
          : modelName;
      pushAction(
        `model:${modelName}`,
        `Model: ${modelName}`,
        modelDetail,
        "model llm codex",
        () => {
          if (!input.activeThread) return;
          input.onSetModel(input.activeThread.id, modelName);
        },
      );
    }
  }

  return actions;
}
