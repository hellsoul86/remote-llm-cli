import type { CodexApprovalPolicy, ConversationThread } from "../../../domains/session";

type SessionComposerAdvancedPanelProps = {
  activeThread: ConversationThread | null;
  activeThreadBusy: boolean;
  onForkSession: () => void;
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
};

export function SessionComposerAdvancedPanel({
  activeThread,
  activeThreadBusy,
  onForkSession,
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
}: SessionComposerAdvancedPanelProps) {
  return (
    <div className="session-advanced-panel composer-secondary-panel">
      <div className="composer-secondary-actions">
        <div className="composer-secondary-copy">
          <strong>Thread actions</strong>
          <p>Keep branch and fork controls secondary to the prompt input.</p>
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
  );
}

export type { SessionComposerAdvancedPanelProps };
