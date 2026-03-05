import {
  type CodexPlatformResult,
  type Host,
} from "../../../api";
import {
  CODEX_PLATFORM_CLOUD_ACTIONS,
  CODEX_PLATFORM_MCP_ACTIONS,
  type CodexPlatformCloudAction,
  type CodexPlatformMCPAction,
} from "../config";
import { formatCodexPlatformResult } from "../view-helpers";

type OpsCodexPlatformPanelProps = {
  hosts: Host[];
  platformHostID: string;
  onPlatformHostChange: (value: string) => void;
  platformBusySection: "" | "login" | "mcp" | "cloud";
  platformNotice: string;
  onRunPlatformLogin: (
    action: "status" | "login_device" | "logout",
  ) => Promise<void>;
  platformLoginResult: CodexPlatformResult | null;
  platformMCPAction: CodexPlatformMCPAction;
  onPlatformMCPActionChange: (value: CodexPlatformMCPAction) => void;
  platformMCPName: string;
  onPlatformMCPNameChange: (value: string) => void;
  platformMCPURL: string;
  onPlatformMCPURLChange: (value: string) => void;
  platformMCPCommand: string;
  onPlatformMCPCommandChange: (value: string) => void;
  platformMCPEnvCSV: string;
  onPlatformMCPEnvCSVChange: (value: string) => void;
  platformMCPBearerTokenEnvVar: string;
  onPlatformMCPBearerTokenEnvVarChange: (value: string) => void;
  platformMCPScopeCSV: string;
  onPlatformMCPScopeCSVChange: (value: string) => void;
  onRunPlatformMCP: () => Promise<void>;
  platformMCPResult: CodexPlatformResult | null;
  platformCloudAction: CodexPlatformCloudAction;
  onPlatformCloudActionChange: (value: CodexPlatformCloudAction) => void;
  platformCloudTaskID: string;
  onPlatformCloudTaskIDChange: (value: string) => void;
  platformCloudEnvID: string;
  onPlatformCloudEnvIDChange: (value: string) => void;
  platformCloudQuery: string;
  onPlatformCloudQueryChange: (value: string) => void;
  platformCloudAttempts: string;
  onPlatformCloudAttemptsChange: (value: string) => void;
  platformCloudBranch: string;
  onPlatformCloudBranchChange: (value: string) => void;
  platformCloudLimit: string;
  onPlatformCloudLimitChange: (value: string) => void;
  platformCloudCursor: string;
  onPlatformCloudCursorChange: (value: string) => void;
  platformCloudAttempt: string;
  onPlatformCloudAttemptChange: (value: string) => void;
  onRunPlatformCloud: () => Promise<void>;
  platformCloudResult: CodexPlatformResult | null;
};

export function OpsCodexPlatformPanel({
  hosts,
  platformHostID,
  onPlatformHostChange,
  platformBusySection,
  platformNotice,
  onRunPlatformLogin,
  platformLoginResult,
  platformMCPAction,
  onPlatformMCPActionChange,
  platformMCPName,
  onPlatformMCPNameChange,
  platformMCPURL,
  onPlatformMCPURLChange,
  platformMCPCommand,
  onPlatformMCPCommandChange,
  platformMCPEnvCSV,
  onPlatformMCPEnvCSVChange,
  platformMCPBearerTokenEnvVar,
  onPlatformMCPBearerTokenEnvVarChange,
  platformMCPScopeCSV,
  onPlatformMCPScopeCSVChange,
  onRunPlatformMCP,
  platformMCPResult,
  platformCloudAction,
  onPlatformCloudActionChange,
  platformCloudTaskID,
  onPlatformCloudTaskIDChange,
  platformCloudEnvID,
  onPlatformCloudEnvIDChange,
  platformCloudQuery,
  onPlatformCloudQueryChange,
  platformCloudAttempts,
  onPlatformCloudAttemptsChange,
  platformCloudBranch,
  onPlatformCloudBranchChange,
  platformCloudLimit,
  onPlatformCloudLimitChange,
  platformCloudCursor,
  onPlatformCloudCursorChange,
  platformCloudAttempt,
  onPlatformCloudAttemptChange,
  onRunPlatformCloud,
  platformCloudResult,
}: OpsCodexPlatformPanelProps) {
  return (
    <section className="inspect-block codex-platform-block">
      <h3>Codex Platform</h3>
      <label>
        target host
        <select
          data-testid="platform-host-select"
          value={platformHostID}
          onChange={(event) => onPlatformHostChange(event.target.value)}
          disabled={hosts.length === 0 || platformBusySection !== ""}
        >
          {hosts.length === 0 ? (
            <option value="">no host</option>
          ) : (
            hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
              </option>
            ))
          )}
        </select>
      </label>
      {platformNotice ? (
        <p className="pane-subtle-light platform-notice">
          {platformNotice}
        </p>
      ) : null}
      <div className="platform-grid">
        <article className="platform-card">
          <h4>Auth</h4>
          <div className="platform-actions-row">
            <button
              type="button"
              className="ghost"
              data-testid="platform-login-status-btn"
              onClick={() => void onRunPlatformLogin("status")}
              disabled={platformBusySection !== "" || !platformHostID}
            >
              Status
            </button>
            <button
              type="button"
              className="ghost"
              data-testid="platform-login-device-btn"
              onClick={() => void onRunPlatformLogin("login_device")}
              disabled={platformBusySection !== "" || !platformHostID}
            >
              Device Login
            </button>
            <button
              type="button"
              className="ghost danger-ghost"
              data-testid="platform-logout-btn"
              onClick={() => void onRunPlatformLogin("logout")}
              disabled={platformBusySection !== "" || !platformHostID}
            >
              Logout
            </button>
          </div>
          <pre
            className="platform-output"
            data-testid="platform-login-output"
          >
            {formatCodexPlatformResult(platformLoginResult)}
          </pre>
        </article>

        <article className="platform-card">
          <h4>MCP</h4>
          <label>
            action
            <select
              data-testid="platform-mcp-action-select"
              value={platformMCPAction}
              onChange={(event) =>
                onPlatformMCPActionChange(
                  event.target.value as CodexPlatformMCPAction,
                )
              }
              disabled={platformBusySection !== ""}
            >
              {CODEX_PLATFORM_MCP_ACTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {platformMCPAction === "get" ||
          platformMCPAction === "add" ||
          platformMCPAction === "remove" ||
          platformMCPAction === "login" ||
          platformMCPAction === "logout" ? (
            <input
              data-testid="platform-mcp-name-input"
              placeholder="server name"
              value={platformMCPName}
              onChange={(event) => onPlatformMCPNameChange(event.target.value)}
              disabled={platformBusySection !== ""}
            />
          ) : null}
          {platformMCPAction === "add" ? (
            <>
              <input
                data-testid="platform-mcp-url-input"
                placeholder="url (for streamable server)"
                value={platformMCPURL}
                onChange={(event) => onPlatformMCPURLChange(event.target.value)}
                disabled={platformBusySection !== ""}
              />
              <input
                data-testid="platform-mcp-command-input"
                placeholder="stdio command (space separated)"
                value={platformMCPCommand}
                onChange={(event) =>
                  onPlatformMCPCommandChange(event.target.value)}
                disabled={platformBusySection !== ""}
              />
              <input
                data-testid="platform-mcp-env-input"
                placeholder="env KEY=VALUE,KEY2=VALUE2"
                value={platformMCPEnvCSV}
                onChange={(event) =>
                  onPlatformMCPEnvCSVChange(event.target.value)}
                disabled={platformBusySection !== ""}
              />
              <input
                data-testid="platform-mcp-bearer-env-input"
                placeholder="bearer token env var"
                value={platformMCPBearerTokenEnvVar}
                onChange={(event) =>
                  onPlatformMCPBearerTokenEnvVarChange(event.target.value)}
                disabled={platformBusySection !== ""}
              />
            </>
          ) : null}
          {platformMCPAction === "login" ? (
            <input
              data-testid="platform-mcp-scopes-input"
              placeholder="scopes (comma separated)"
              value={platformMCPScopeCSV}
              onChange={(event) =>
                onPlatformMCPScopeCSVChange(event.target.value)}
              disabled={platformBusySection !== ""}
            />
          ) : null}
          <div className="platform-actions-row">
            <button
              type="button"
              className="ghost"
              data-testid="platform-mcp-run-btn"
              onClick={() => void onRunPlatformMCP()}
              disabled={platformBusySection !== "" || !platformHostID}
            >
              Run MCP
            </button>
          </div>
          <pre className="platform-output" data-testid="platform-mcp-output">
            {formatCodexPlatformResult(platformMCPResult)}
          </pre>
        </article>

        <article className="platform-card">
          <h4>Cloud</h4>
          <label>
            action
            <select
              data-testid="platform-cloud-action-select"
              value={platformCloudAction}
              onChange={(event) =>
                onPlatformCloudActionChange(
                  event.target.value as CodexPlatformCloudAction,
                )
              }
              disabled={platformBusySection !== ""}
            >
              {CODEX_PLATFORM_CLOUD_ACTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {platformCloudAction === "status" ||
          platformCloudAction === "diff" ||
          platformCloudAction === "apply" ? (
            <input
              data-testid="platform-cloud-task-id-input"
              placeholder="task id"
              value={platformCloudTaskID}
              onChange={(event) =>
                onPlatformCloudTaskIDChange(event.target.value)}
              disabled={platformBusySection !== ""}
            />
          ) : null}
          {platformCloudAction === "exec" ? (
            <>
              <input
                data-testid="platform-cloud-env-id-input"
                placeholder="env id"
                value={platformCloudEnvID}
                onChange={(event) => onPlatformCloudEnvIDChange(event.target.value)}
                disabled={platformBusySection !== ""}
              />
              <input
                data-testid="platform-cloud-query-input"
                placeholder="query"
                value={platformCloudQuery}
                onChange={(event) => onPlatformCloudQueryChange(event.target.value)}
                disabled={platformBusySection !== ""}
              />
              <input
                data-testid="platform-cloud-attempts-input"
                placeholder="attempts"
                value={platformCloudAttempts}
                onChange={(event) =>
                  onPlatformCloudAttemptsChange(event.target.value)}
                disabled={platformBusySection !== ""}
              />
              <input
                data-testid="platform-cloud-branch-input"
                placeholder="branch"
                value={platformCloudBranch}
                onChange={(event) =>
                  onPlatformCloudBranchChange(event.target.value)}
                disabled={platformBusySection !== ""}
              />
            </>
          ) : null}
          {platformCloudAction === "list" ? (
            <>
              <input
                data-testid="platform-cloud-list-env-input"
                placeholder="env id (optional)"
                value={platformCloudEnvID}
                onChange={(event) => onPlatformCloudEnvIDChange(event.target.value)}
                disabled={platformBusySection !== ""}
              />
              <input
                data-testid="platform-cloud-limit-input"
                placeholder="limit"
                value={platformCloudLimit}
                onChange={(event) => onPlatformCloudLimitChange(event.target.value)}
                disabled={platformBusySection !== ""}
              />
              <input
                data-testid="platform-cloud-cursor-input"
                placeholder="cursor"
                value={platformCloudCursor}
                onChange={(event) =>
                  onPlatformCloudCursorChange(event.target.value)}
                disabled={platformBusySection !== ""}
              />
            </>
          ) : null}
          {platformCloudAction === "diff" ||
          platformCloudAction === "apply" ? (
            <input
              data-testid="platform-cloud-attempt-input"
              placeholder="attempt (optional)"
              value={platformCloudAttempt}
              onChange={(event) =>
                onPlatformCloudAttemptChange(event.target.value)}
              disabled={platformBusySection !== ""}
            />
          ) : null}
          <div className="platform-actions-row">
            <button
              type="button"
              className="ghost"
              data-testid="platform-cloud-run-btn"
              onClick={() => void onRunPlatformCloud()}
              disabled={platformBusySection !== "" || !platformHostID}
            >
              Run Cloud
            </button>
          </div>
          <pre
            className="platform-output"
            data-testid="platform-cloud-output"
          >
            {formatCodexPlatformResult(platformCloudResult)}
          </pre>
        </article>
      </div>
    </section>
  );
}
