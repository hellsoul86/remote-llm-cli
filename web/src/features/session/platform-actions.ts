import type { Dispatch, SetStateAction } from "react";
import {
  codexPlatformCloud,
  codexPlatformLogin,
  codexPlatformMCP,
  type CodexPlatformCloudRequest,
  type CodexPlatformMCPRequest,
  type CodexPlatformResult,
} from "../../api";
import type {
  CodexPlatformCloudAction,
  CodexPlatformMCPAction,
} from "./config";
import { splitCSVValues } from "./view-helpers";

type PlatformBusySection = "" | "login" | "mcp" | "cloud";

type CreatePlatformActionsDeps = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  platformHostID: string;
  platformHostName: string;

  platformMCPAction: CodexPlatformMCPAction;
  platformMCPName: string;
  platformMCPURL: string;
  platformMCPCommand: string;
  platformMCPEnvCSV: string;
  platformMCPBearerTokenEnvVar: string;
  platformMCPScopeCSV: string;

  platformCloudAction: CodexPlatformCloudAction;
  platformCloudTaskID: string;
  platformCloudEnvID: string;
  platformCloudQuery: string;
  platformCloudAttempts: string;
  platformCloudBranch: string;
  platformCloudLimit: string;
  platformCloudCursor: string;
  platformCloudAttempt: string;

  setPlatformBusySection: Dispatch<SetStateAction<PlatformBusySection>>;
  setPlatformNotice: Dispatch<SetStateAction<string>>;
  setPlatformLoginResult: Dispatch<SetStateAction<CodexPlatformResult | null>>;
  setPlatformMCPResult: Dispatch<SetStateAction<CodexPlatformResult | null>>;
  setPlatformCloudResult: Dispatch<SetStateAction<CodexPlatformResult | null>>;
};

export function createPlatformActions(deps: CreatePlatformActionsDeps) {
  const canRun = () => deps.authPhase === "ready" && deps.token.trim() !== "";

  const normalizeHostID = (): string => {
    if (!canRun()) return "";
    const hostID = deps.platformHostID.trim();
    if (hostID) return hostID;
    deps.setPlatformNotice("Select a target host first.");
    return "";
  };

  const hostLabel = (hostID: string) => deps.platformHostName || hostID;

  const onRunPlatformLogin = async (
    action: "status" | "login_device" | "logout",
  ) => {
    const hostID = normalizeHostID();
    if (!hostID) return;

    deps.setPlatformBusySection("login");
    deps.setPlatformNotice(`Running login ${action} on ${hostLabel(hostID)}...`);
    try {
      const result = await codexPlatformLogin(deps.token, {
        host_id: hostID,
        action,
      });
      deps.setPlatformLoginResult(result);
      deps.setPlatformNotice(`Login ${action} finished on ${result.host.name}.`);
    } catch (error) {
      deps.setPlatformNotice(String(error));
    } finally {
      deps.setPlatformBusySection("");
    }
  };

  const onRunPlatformMCP = async () => {
    const hostID = normalizeHostID();
    if (!hostID) return;

    const command = deps.platformMCPCommand
      .trim()
      .split(/\s+/)
      .filter((item) => item !== "");

    const request: CodexPlatformMCPRequest = {
      host_id: hostID,
      action: deps.platformMCPAction,
    };
    if (deps.platformMCPName.trim()) {
      request.name = deps.platformMCPName.trim();
    }
    if (deps.platformMCPURL.trim()) {
      request.url = deps.platformMCPURL.trim();
    }
    if (command.length > 0) {
      request.command = command;
    }
    const envValues = splitCSVValues(deps.platformMCPEnvCSV);
    if (envValues.length > 0) {
      request.env = envValues;
    }
    if (deps.platformMCPBearerTokenEnvVar.trim()) {
      request.bearer_token_env_var = deps.platformMCPBearerTokenEnvVar.trim();
    }
    const scopeValues = splitCSVValues(deps.platformMCPScopeCSV);
    if (scopeValues.length > 0) {
      request.scopes = scopeValues;
    }

    deps.setPlatformBusySection("mcp");
    deps.setPlatformNotice(
      `Running mcp ${deps.platformMCPAction} on ${hostLabel(hostID)}...`,
    );
    try {
      const result = await codexPlatformMCP(deps.token, request);
      deps.setPlatformMCPResult(result);
      deps.setPlatformNotice(
        `MCP ${deps.platformMCPAction} finished on ${result.host.name}.`,
      );
    } catch (error) {
      deps.setPlatformNotice(String(error));
    } finally {
      deps.setPlatformBusySection("");
    }
  };

  const onRunPlatformCloud = async () => {
    const hostID = normalizeHostID();
    if (!hostID) return;

    const attempts = Number.parseInt(deps.platformCloudAttempts, 10);
    const limit = Number.parseInt(deps.platformCloudLimit, 10);
    const attempt = Number.parseInt(deps.platformCloudAttempt, 10);

    const request: CodexPlatformCloudRequest = {
      host_id: hostID,
      action: deps.platformCloudAction,
    };
    if (deps.platformCloudTaskID.trim()) {
      request.task_id = deps.platformCloudTaskID.trim();
    }
    if (deps.platformCloudEnvID.trim()) {
      request.env_id = deps.platformCloudEnvID.trim();
    }
    if (deps.platformCloudQuery.trim()) {
      request.query = deps.platformCloudQuery.trim();
    }
    if (Number.isFinite(attempts) && attempts > 0) {
      request.attempts = attempts;
    }
    if (deps.platformCloudBranch.trim()) {
      request.branch = deps.platformCloudBranch.trim();
    }
    if (Number.isFinite(limit) && limit > 0) {
      request.limit = limit;
    }
    if (deps.platformCloudCursor.trim()) {
      request.cursor = deps.platformCloudCursor.trim();
    }
    if (Number.isFinite(attempt) && attempt > 0) {
      request.attempt = attempt;
    }

    deps.setPlatformBusySection("cloud");
    deps.setPlatformNotice(
      `Running cloud ${deps.platformCloudAction} on ${hostLabel(hostID)}...`,
    );
    try {
      const result = await codexPlatformCloud(deps.token, request);
      deps.setPlatformCloudResult(result);
      deps.setPlatformNotice(
        `Cloud ${deps.platformCloudAction} finished on ${result.host.name}.`,
      );
    } catch (error) {
      deps.setPlatformNotice(String(error));
    } finally {
      deps.setPlatformBusySection("");
    }
  };

  return {
    onRunPlatformLogin,
    onRunPlatformMCP,
    onRunPlatformCloud,
  };
}
