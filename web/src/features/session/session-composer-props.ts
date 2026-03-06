import type {
  ComponentProps,
  Dispatch,
  SetStateAction,
} from "react";

import type { CodexApprovalPolicy } from "../../domains/session";
import { SessionComposer } from "./components/SessionComposer";

type SessionComposerProps = ComponentProps<typeof SessionComposer>;
type SessionSandbox = Parameters<SessionComposerProps["onSetThreadSandbox"]>[0];
type ResolvePendingRequestPayload = Parameters<
  SessionComposerProps["onResolvePendingRequest"]
>[1];

type BuildSessionComposerPropsDeps = Pick<
  SessionComposerProps,
  | "formRef"
  | "promptInputRef"
  | "composerDropActive"
  | "onSubmit"
  | "onDragEnter"
  | "onDragOver"
  | "onDragLeave"
  | "onDrop"
  | "activeThreadStatusCopy"
  | "activeThread"
  | "activeThreadBusy"
  | "activeThreadModelValue"
  | "hasSessionModelChoices"
  | "sessionModelChoices"
  | "sessionModelDefault"
  | "sessionAdvancedOpen"
  | "approvalPolicyOptions"
  | "configFlagDraft"
  | "onConfigFlagDraftChange"
  | "onConfigFlagDraftSubmit"
  | "enableFlagDraft"
  | "onEnableFlagDraftChange"
  | "onEnableFlagDraftSubmit"
  | "disableFlagDraft"
  | "onDisableFlagDraftChange"
  | "onDisableFlagDraftSubmit"
  | "addDirDraft"
  | "onAddDirDraftChange"
  | "onAddDirDraftSubmit"
  | "pendingRequests"
  | "pendingRequestsLoading"
  | "pendingRequestsError"
  | "resolvingPendingRequestID"
  | "uploadingImage"
  | "imageUploadError"
  | "activeDraft"
  | "onComposerPaste"
  | "activeThreadRunID"
  | "cancelingThreadID"
  | "hasRegeneratePrompt"
> & {
  setThreadModel: (threadID: string, modelName: string) => void;
  setThreadSandbox: (threadID: string, value: SessionSandbox) => void;
  onForkActiveSession: () => Promise<void>;
  setSessionAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  setThreadApprovalPolicy: (
    threadID: string,
    value: CodexApprovalPolicy,
  ) => void;
  setThreadWebSearch: (threadID: string, next: boolean) => void;
  setThreadProfile: (threadID: string, value: string) => void;
  removeThreadConfigFlag: (threadID: string, value: string) => void;
  removeThreadEnableFlag: (threadID: string, value: string) => void;
  removeThreadDisableFlag: (threadID: string, value: string) => void;
  removeThreadAddDir: (threadID: string, value: string) => void;
  setThreadSkipGitRepoCheck: (threadID: string, next: boolean) => void;
  setThreadJSONOutput: (threadID: string, next: boolean) => void;
  setThreadEphemeral: (threadID: string, next: boolean) => void;
  refreshPendingRequests: () => Promise<void>;
  resolvePendingRequest: (
    requestID: string,
    payload: ResolvePendingRequestPayload,
  ) => Promise<void>;
  onUploadSessionImage: (file: File, threadID: string) => Promise<void>;
  removeThreadImagePath: (threadID: string, imagePath: string) => void;
  updateThreadDraft: (threadID: string, value: string) => void;
  onStopActiveSessionRun: () => Promise<void>;
  onRegenerateActiveSession: () => Promise<void>;
};

export function buildSessionComposerProps(
  deps: BuildSessionComposerPropsDeps,
): SessionComposerProps {
  const activeThreadID = deps.activeThread?.id ?? "";

  const withActiveThread = <Args extends unknown[]>(
    action: (threadID: string, ...args: Args) => void,
  ) => {
    return (...args: Args) => {
      if (!activeThreadID) return;
      action(activeThreadID, ...args);
    };
  };

  return {
    formRef: deps.formRef,
    promptInputRef: deps.promptInputRef,
    composerDropActive: deps.composerDropActive,
    onSubmit: deps.onSubmit,
    onDragEnter: deps.onDragEnter,
    onDragOver: deps.onDragOver,
    onDragLeave: deps.onDragLeave,
    onDrop: deps.onDrop,
    activeThreadStatusCopy: deps.activeThreadStatusCopy,
    activeThread: deps.activeThread,
    activeThreadBusy: deps.activeThreadBusy,
    activeThreadModelValue: deps.activeThreadModelValue,
    hasSessionModelChoices: deps.hasSessionModelChoices,
    sessionModelChoices: deps.sessionModelChoices,
    sessionModelDefault: deps.sessionModelDefault,
    onSetThreadModel: withActiveThread(deps.setThreadModel),
    onSetThreadSandbox: withActiveThread(deps.setThreadSandbox),
    onForkSession: () => {
      void deps.onForkActiveSession();
    },
    sessionAdvancedOpen: deps.sessionAdvancedOpen,
    onToggleSessionAdvanced: () => {
      deps.setSessionAdvancedOpen((prev) => !prev);
    },
    approvalPolicyOptions: deps.approvalPolicyOptions,
    onSetThreadApprovalPolicy: withActiveThread(deps.setThreadApprovalPolicy),
    onSetThreadWebSearch: withActiveThread(deps.setThreadWebSearch),
    onSetThreadProfile: withActiveThread(deps.setThreadProfile),
    configFlagDraft: deps.configFlagDraft,
    onConfigFlagDraftChange: deps.onConfigFlagDraftChange,
    onConfigFlagDraftSubmit: deps.onConfigFlagDraftSubmit,
    onRemoveConfigFlag: withActiveThread(deps.removeThreadConfigFlag),
    enableFlagDraft: deps.enableFlagDraft,
    onEnableFlagDraftChange: deps.onEnableFlagDraftChange,
    onEnableFlagDraftSubmit: deps.onEnableFlagDraftSubmit,
    onRemoveEnableFlag: withActiveThread(deps.removeThreadEnableFlag),
    disableFlagDraft: deps.disableFlagDraft,
    onDisableFlagDraftChange: deps.onDisableFlagDraftChange,
    onDisableFlagDraftSubmit: deps.onDisableFlagDraftSubmit,
    onRemoveDisableFlag: withActiveThread(deps.removeThreadDisableFlag),
    addDirDraft: deps.addDirDraft,
    onAddDirDraftChange: deps.onAddDirDraftChange,
    onAddDirDraftSubmit: deps.onAddDirDraftSubmit,
    onRemoveAddDir: withActiveThread(deps.removeThreadAddDir),
    onSetThreadSkipGitRepoCheck: withActiveThread(
      deps.setThreadSkipGitRepoCheck,
    ),
    onSetThreadJSONOutput: withActiveThread(deps.setThreadJSONOutput),
    onSetThreadEphemeral: withActiveThread(deps.setThreadEphemeral),
    pendingRequests: deps.pendingRequests,
    pendingRequestsLoading: deps.pendingRequestsLoading,
    pendingRequestsError: deps.pendingRequestsError,
    resolvingPendingRequestID: deps.resolvingPendingRequestID,
    onRefreshPendingRequests: () => {
      void deps.refreshPendingRequests();
    },
    onResolvePendingRequest: async (requestID, payload) => {
      await deps.resolvePendingRequest(requestID, payload);
    },
    uploadingImage: deps.uploadingImage,
    imageUploadError: deps.imageUploadError,
    onUploadImage: (file, threadID) => {
      void deps.onUploadSessionImage(file, threadID);
    },
    onRemoveImagePath: withActiveThread(deps.removeThreadImagePath),
    activeDraft: deps.activeDraft,
    onDraftChange: withActiveThread(deps.updateThreadDraft),
    onComposerPaste: deps.onComposerPaste,
    activeThreadRunID: deps.activeThreadRunID,
    cancelingThreadID: deps.cancelingThreadID,
    onStopRun: () => {
      void deps.onStopActiveSessionRun();
    },
    hasRegeneratePrompt: deps.hasRegeneratePrompt,
    onRegenerate: () => {
      void deps.onRegenerateActiveSession();
    },
  };
}
