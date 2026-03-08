import {
  type ClipboardEvent as ReactClipboardEvent,
  type ComponentProps,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from "react";
import { type CodexV2PendingRequest } from "../../../api";
import { type ConversationThread } from "../../../domains/session";
import { SessionComposerAdvancedPanel } from "./SessionComposerAdvancedPanel";
import { SessionPendingRequests } from "./SessionPendingRequests";

const SANDBOX_OPTIONS: Array<{
  value: "" | "read-only" | "workspace-write" | "danger-full-access";
  label: string;
}> = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "danger-full-access", label: "Full access" },
];

type SessionComposerAdvancedPanelProps = ComponentProps<
  typeof SessionComposerAdvancedPanel
>;

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
  sessionAdvancedOpen: boolean;
  onToggleSessionAdvanced: () => void;
  advancedPanelProps: SessionComposerAdvancedPanelProps;
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
  sessionAdvancedOpen,
  onToggleSessionAdvanced,
  advancedPanelProps,
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
        <SessionComposerAdvancedPanel {...advancedPanelProps} />
      ) : null}

      <div className="composer-input-shell">
        <div className="composer-input-topbar">
          <div className="composer-context-cluster">
            <label
              className="composer-select-pill composer-select-pill-compact"
              aria-label="Model"
            >
              <span className="composer-select-label">Model</span>
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
            <label
              className="composer-select-pill composer-select-pill-compact"
              aria-label="Permissions"
            >
              <span className="composer-select-label">Permissions</span>
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
