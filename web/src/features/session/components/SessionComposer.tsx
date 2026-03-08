import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from "react";
import { type CodexV2PendingRequest } from "../../../api";
import { SessionPendingRequests } from "./SessionPendingRequests";

import {
  type CodexApprovalPolicy,
  type ConversationThread,
} from "../../../domains/session";

const SANDBOX_OPTIONS: Array<{
  value: "" | "read-only" | "workspace-write" | "danger-full-access";
  label: string;
}> = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "danger-full-access", label: "Full access" },
];

type SessionComposerProps = {
  formRef: MutableRefObject<HTMLFormElement | null>;
  promptInputRef: MutableRefObject<HTMLTextAreaElement | null>;
  composerDropActive: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  activeThreadStatusCopy: string;
  activeThread: ConversationThread | null;
  activeThreadBusy: boolean;
  activeThreadModelValue: string;
  hasSessionModelChoices: boolean;
  sessionModelChoices: string[];
  sessionModelDefault: string;
  onSetThreadModel: (modelName: string) => void;
  onSetThreadSandbox: (
    value: "" | "read-only" | "workspace-write" | "danger-full-access",
  ) => void;
  onForkSession: () => void;
  sessionAdvancedOpen: boolean;
  onToggleSessionAdvanced: () => void;
  approvalPolicyOptions: Array<{ value: CodexApprovalPolicy; label: string }>;
  onSetThreadApprovalPolicy: (value: CodexApprovalPolicy) => void;
  onSetThreadWebSearch: (next: boolean) => void;
  onSetThreadProfile: (value: string) => void;
  configFlagDraft: string;
  onConfigFlagDraftChange: (value: string) => void;
  onConfigFlagDraftSubmit: () => void;
  onRemoveConfigFlag: (value: string) => void;
  enableFlagDraft: string;
  onEnableFlagDraftChange: (value: string) => void;
  onEnableFlagDraftSubmit: () => void;
  onRemoveEnableFlag: (value: string) => void;
  disableFlagDraft: string;
  onDisableFlagDraftChange: (value: string) => void;
  onDisableFlagDraftSubmit: () => void;
  onRemoveDisableFlag: (value: string) => void;
  addDirDraft: string;
  onAddDirDraftChange: (value: string) => void;
  onAddDirDraftSubmit: () => void;
  onRemoveAddDir: (value: string) => void;
  onSetThreadSkipGitRepoCheck: (next: boolean) => void;
  onSetThreadJSONOutput: (next: boolean) => void;
  onSetThreadEphemeral: (next: boolean) => void;
  pendingRequests: CodexV2PendingRequest[];
  pendingRequestsLoading: boolean;
  pendingRequestsError: string;
  resolvingPendingRequestID: string;
  onRefreshPendingRequests: () => void;
  onResolvePendingRequest: (
    requestID: string,
    payload: {
      decision?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    },
  ) => Promise<void>;
  uploadingImage: boolean;
  imageUploadError: string;
  onUploadImage: (file: File, threadID: string) => void;
  onRemoveImagePath: (imagePath: string) => void;
  activeDraft: string;
  onDraftChange: (value: string) => void;
  onComposerPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  activeThreadRunID: string;
  cancelingThreadID: string;
  onStopRun: () => void;
  hasRegeneratePrompt: boolean;
  onRegenerate: () => void;
};

export function SessionComposer({
  formRef,
  promptInputRef,
  composerDropActive,
  onSubmit,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  activeThreadStatusCopy,
  activeThread,
  activeThreadBusy,
  activeThreadModelValue,
  hasSessionModelChoices,
  sessionModelChoices,
  sessionModelDefault,
  onSetThreadModel,
  onSetThreadSandbox,
  onForkSession,
  sessionAdvancedOpen,
  onToggleSessionAdvanced,
  approvalPolicyOptions,
  onSetThreadApprovalPolicy,
  onSetThreadWebSearch,
  onSetThreadProfile,
  configFlagDraft,
  onConfigFlagDraftChange,
  onConfigFlagDraftSubmit,
  onRemoveConfigFlag,
  enableFlagDraft,
  onEnableFlagDraftChange,
  onEnableFlagDraftSubmit,
  onRemoveEnableFlag,
  disableFlagDraft,
  onDisableFlagDraftChange,
  onDisableFlagDraftSubmit,
  onRemoveDisableFlag,
  addDirDraft,
  onAddDirDraftChange,
  onAddDirDraftSubmit,
  onRemoveAddDir,
  onSetThreadSkipGitRepoCheck,
  onSetThreadJSONOutput,
  onSetThreadEphemeral,
  pendingRequests,
  pendingRequestsLoading,
  pendingRequestsError,
  resolvingPendingRequestID,
  onRefreshPendingRequests,
  onResolvePendingRequest,
  uploadingImage,
  imageUploadError,
  onUploadImage,
  onRemoveImagePath,
  activeDraft,
  onDraftChange,
  onComposerPaste,
  activeThreadRunID,
  cancelingThreadID,
  onStopRun,
  hasRegeneratePrompt,
  onRegenerate,
}: SessionComposerProps) {
  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const composing =
      "isComposing" in event.nativeEvent
        ? Boolean((event.nativeEvent as { isComposing?: boolean }).isComposing)
        : false;
    if (event.key === "Enter" && !event.shiftKey && !composing) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  return (
    <form
      ref={formRef}
      className={`composer ${composerDropActive ? "drop-active" : ""}`}
      onSubmit={onSubmit}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {composerDropActive ? (
        <p className="composer-drop-indicator" role="status">
          Drop image to attach.
        </p>
      ) : null}
      <SessionPendingRequests
        requests={pendingRequests}
        loading={pendingRequestsLoading}
        error={pendingRequestsError}
        resolvingRequestID={resolvingPendingRequestID}
        onRefresh={onRefreshPendingRequests}
        onResolve={onResolvePendingRequest}
      />

      {sessionAdvancedOpen ? (
        <div className="session-advanced-panel composer-secondary-panel">
          <div className="composer-secondary-actions">
            <div className="composer-secondary-copy">
              <strong>Thread actions</strong>
              <p>Keep branch/fork controls secondary to the prompt input.</p>
            </div>
            <button
              type="button"
              className="ghost"
              data-testid="fork-session-btn"
              onClick={onForkSession}
              disabled={!activeThread || activeThreadBusy}
            >
              Fork thread
            </button>
          </div>
          <label className="session-setting-row">
            approval
            <select
              data-testid="advanced-approval-select"
              value={activeThread?.approvalPolicy ?? ""}
              disabled={!activeThread || activeThreadBusy}
              onChange={(event) =>
                onSetThreadApprovalPolicy(event.target.value as CodexApprovalPolicy)
              }
            >
              {approvalPolicyOptions.map((option) => (
                <option key={option.label} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="session-setting-row toggle-setting-row">
            <span>web search</span>
            <input
              type="checkbox"
              data-testid="advanced-web-search-toggle"
              checked={Boolean(activeThread?.webSearch)}
              disabled={!activeThread || activeThreadBusy}
              onChange={(event) => onSetThreadWebSearch(event.target.checked)}
            />
          </label>

          <label className="session-setting-row">
            profile
            <input
              data-testid="advanced-profile-input"
              placeholder="default"
              value={activeThread?.profile ?? ""}
              disabled={!activeThread || activeThreadBusy}
              onChange={(event) => onSetThreadProfile(event.target.value)}
            />
          </label>

          <label className="session-setting-row">
            config (-c)
            <div className="add-dir-row">
              <input
                data-testid="advanced-config-input"
                placeholder="sandbox_workspace_write=true"
                value={configFlagDraft}
                disabled={!activeThread || activeThreadBusy}
                onChange={(event) => onConfigFlagDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  onConfigFlagDraftSubmit();
                }}
              />
              <button
                type="button"
                className="ghost"
                disabled={!activeThread || activeThreadBusy || !configFlagDraft.trim()}
                onClick={onConfigFlagDraftSubmit}
              >
                Add
              </button>
            </div>
            <div className="add-dir-list">
              {(activeThread?.configFlags ?? []).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="quick-chip ghost"
                  disabled={!activeThread || activeThreadBusy}
                  onClick={() => onRemoveConfigFlag(value)}
                >
                  {value} ×
                </button>
              ))}
            </div>
          </label>

          <label className="session-setting-row">
            enable
            <div className="add-dir-row">
              <input
                data-testid="advanced-enable-input"
                placeholder="web_search"
                value={enableFlagDraft}
                disabled={!activeThread || activeThreadBusy}
                onChange={(event) => onEnableFlagDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  onEnableFlagDraftSubmit();
                }}
              />
              <button
                type="button"
                className="ghost"
                disabled={!activeThread || activeThreadBusy || !enableFlagDraft.trim()}
                onClick={onEnableFlagDraftSubmit}
              >
                Add
              </button>
            </div>
            <div className="add-dir-list">
              {(activeThread?.enableFlags ?? []).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="quick-chip ghost"
                  disabled={!activeThread || activeThreadBusy}
                  onClick={() => onRemoveEnableFlag(value)}
                >
                  {value} ×
                </button>
              ))}
            </div>
          </label>

          <label className="session-setting-row">
            disable
            <div className="add-dir-row">
              <input
                data-testid="advanced-disable-input"
                placeholder="legacy_preview"
                value={disableFlagDraft}
                disabled={!activeThread || activeThreadBusy}
                onChange={(event) => onDisableFlagDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  onDisableFlagDraftSubmit();
                }}
              />
              <button
                type="button"
                className="ghost"
                disabled={!activeThread || activeThreadBusy || !disableFlagDraft.trim()}
                onClick={onDisableFlagDraftSubmit}
              >
                Add
              </button>
            </div>
            <div className="add-dir-list">
              {(activeThread?.disableFlags ?? []).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="quick-chip ghost"
                  disabled={!activeThread || activeThreadBusy}
                  onClick={() => onRemoveDisableFlag(value)}
                >
                  {value} ×
                </button>
              ))}
            </div>
          </label>

          <label className="session-setting-row">
            add dir
            <div className="add-dir-row">
              <input
                data-testid="advanced-add-dir-input"
                placeholder="/opt/shared"
                value={addDirDraft}
                disabled={!activeThread || activeThreadBusy}
                onChange={(event) => onAddDirDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  onAddDirDraftSubmit();
                }}
              />
              <button
                type="button"
                className="ghost"
                disabled={!activeThread || activeThreadBusy || !addDirDraft.trim()}
                onClick={onAddDirDraftSubmit}
              >
                Add
              </button>
            </div>
            <div className="add-dir-list">
              {(activeThread?.addDirs ?? []).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  className="quick-chip ghost"
                  disabled={!activeThread || activeThreadBusy}
                  onClick={() => onRemoveAddDir(dir)}
                >
                  {dir} ×
                </button>
              ))}
            </div>
          </label>

          <div className="advanced-toggle-grid">
            <label className="session-setting-row toggle-setting-row">
              <span>skip repo check</span>
              <input
                type="checkbox"
                data-testid="advanced-skip-git-toggle"
                checked={activeThread?.skipGitRepoCheck ?? true}
                disabled={!activeThread || activeThreadBusy}
                onChange={(event) => onSetThreadSkipGitRepoCheck(event.target.checked)}
              />
            </label>
            <label className="session-setting-row toggle-setting-row">
              <span>json output</span>
              <input
                type="checkbox"
                data-testid="advanced-json-output-toggle"
                checked={activeThread?.jsonOutput ?? true}
                disabled={!activeThread || activeThreadBusy}
                onChange={(event) => onSetThreadJSONOutput(event.target.checked)}
              />
            </label>
            <label className="session-setting-row toggle-setting-row">
              <span>ephemeral</span>
              <input
                type="checkbox"
                data-testid="advanced-ephemeral-toggle"
                checked={activeThread?.ephemeral ?? false}
                disabled={!activeThread || activeThreadBusy}
                onChange={(event) => onSetThreadEphemeral(event.target.checked)}
              />
            </label>
          </div>
        </div>
      ) : null}

      <div className="composer-input-shell">
        <div className="composer-input-topbar">
          <div className="composer-context-cluster">
            <label className="composer-select-pill" aria-label="Model">
              <span>Model</span>
              <select
                data-testid="session-model-select"
                value={activeThreadModelValue}
                disabled={!activeThread || !hasSessionModelChoices || activeThreadBusy}
                onChange={(event) => onSetThreadModel(event.target.value)}
              >
                {hasSessionModelChoices ? (
                  sessionModelChoices.map((modelName) => (
                    <option key={modelName} value={modelName}>
                      {modelName === sessionModelDefault
                        ? `${modelName} (default)`
                        : modelName}
                    </option>
                  ))
                ) : (
                  <option value="">model unavailable</option>
                )}
              </select>
            </label>
            <label className="composer-select-pill" aria-label="Permissions">
              <span>Permissions</span>
              <select
                data-testid="session-sandbox-select"
                value={activeThread?.sandbox ?? "workspace-write"}
                disabled={!activeThread || activeThreadBusy}
                onChange={(event) =>
                  onSetThreadSandbox(
                    event.target.value as
                      | ""
                      | "read-only"
                      | "workspace-write"
                      | "danger-full-access",
                  )
                }
              >
                {SANDBOX_OPTIONS.map((option) => (
                  <option key={option.value || "default"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="composer-input-tools">
            <label
              className={`ghost composer-attach-btn file-chip ${
                uploadingImage || !activeThread || activeThreadBusy ? "disabled" : ""
              }`}
            >
              <input
                type="file"
                accept="image/*"
                disabled={uploadingImage || !activeThread || activeThreadBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (!activeThread) return;
                  onUploadImage(file, activeThread.id);
                  event.currentTarget.value = "";
                }}
              />
                {uploadingImage ? "Uploading..." : "Attach Image"}
              </label>
            <button
              type="button"
              className="ghost composer-inline-action"
              data-testid="advanced-toggle-btn"
              onClick={onToggleSessionAdvanced}
              disabled={!activeThread}
            >
              {sessionAdvancedOpen ? "Hide More" : "More"}
            </button>
            <span className="shortcut-hint composer-shortcut-hint">
              / commands · @ context · paste image
            </span>
          </div>
        </div>
        {!hasSessionModelChoices ? (
          <small className="pane-subtle-light composer-shell-note">
            No models discovered on this server.
          </small>
        ) : null}

        {(activeThread?.imagePaths ?? []).length > 0 || imageUploadError ? (
          <div className="quick-strip quick-strip-attachments">
            {(activeThread?.imagePaths ?? []).map((imagePath) => (
              <button
                key={imagePath}
                type="button"
                className="quick-chip ghost"
                onClick={() => onRemoveImagePath(imagePath)}
              >
                {imagePath.split("/").pop() ?? imagePath} ×
              </button>
            ))}
            {imageUploadError ? (
              <span className="shortcut-hint">{imageUploadError}</span>
            ) : null}
          </div>
        ) : null}

        <textarea
          ref={promptInputRef}
          value={activeDraft}
          onChange={(event) => onDraftChange(event.target.value)}
          rows={1}
          placeholder={
            activeThread
              ? "Ask Codex to work in this project..."
              : "Select a thread to start"
          }
          disabled={!activeThread}
          onPaste={onComposerPaste}
          onKeyDown={onComposerKeyDown}
        />

        <div className="composer-input-footer">
          <p className="composer-status" role="status">
            {activeThreadStatusCopy || "Enter sends · Shift+Enter adds a line break"}
          </p>
          <div className="composer-actions">
            {activeThreadRunID ? (
              <button
                type="button"
                className="ghost danger-ghost"
                disabled={
                  !activeThread ||
                  !activeThreadRunID ||
                  cancelingThreadID === activeThread.id
                }
                onClick={onStopRun}
              >
                {activeThread && cancelingThreadID === activeThread.id
                  ? "Stopping..."
                  : "Stop"}
              </button>
            ) : (
              <button
                type="button"
                className="ghost"
                disabled={!activeThread || !hasRegeneratePrompt || activeThreadBusy}
                onClick={onRegenerate}
              >
                Regenerate
              </button>
            )}
            <button type="submit" disabled={activeThreadBusy || !activeThread}>
              {activeThreadBusy ? "Running..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
