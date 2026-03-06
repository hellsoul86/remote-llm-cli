import {
  type ComponentProps,
  useEffect,
  useMemo,
  useState,
} from "react";

import type {
  CodexPlatformResult,
  Host,
} from "../../api";
import {
  type CodexPlatformCloudAction,
  type CodexPlatformMCPAction,
} from "./config";
import { createPlatformActions } from "./platform-actions";
import { OpsCodexPlatformPanel } from "./components/OpsCodexPlatformPanel";

type AuthPhase = "checking" | "locked" | "ready";

type UseCodexPlatformControllerArgs = {
  authPhase: AuthPhase;
  token: string;
  hosts: Host[];
  activeWorkspaceHostID: string;
};

export function useCodexPlatformController({
  authPhase,
  token,
  hosts,
  activeWorkspaceHostID,
}: UseCodexPlatformControllerArgs) {
  const [platformHostID, setPlatformHostID] = useState("");
  const [platformBusySection, setPlatformBusySection] = useState<
    "" | "login" | "mcp" | "cloud"
  >("");
  const [platformNotice, setPlatformNotice] = useState("");
  const [platformLoginResult, setPlatformLoginResult] =
    useState<CodexPlatformResult | null>(null);
  const [platformMCPAction, setPlatformMCPAction] =
    useState<CodexPlatformMCPAction>("list");
  const [platformMCPName, setPlatformMCPName] = useState("");
  const [platformMCPURL, setPlatformMCPURL] = useState("");
  const [platformMCPCommand, setPlatformMCPCommand] = useState("");
  const [platformMCPEnvCSV, setPlatformMCPEnvCSV] = useState("");
  const [platformMCPBearerTokenEnvVar, setPlatformMCPBearerTokenEnvVar] =
    useState("");
  const [platformMCPScopeCSV, setPlatformMCPScopeCSV] = useState("");
  const [platformMCPResult, setPlatformMCPResult] =
    useState<CodexPlatformResult | null>(null);
  const [platformCloudAction, setPlatformCloudAction] =
    useState<CodexPlatformCloudAction>("list");
  const [platformCloudTaskID, setPlatformCloudTaskID] = useState("");
  const [platformCloudEnvID, setPlatformCloudEnvID] = useState("");
  const [platformCloudQuery, setPlatformCloudQuery] = useState("");
  const [platformCloudAttempts, setPlatformCloudAttempts] = useState("1");
  const [platformCloudBranch, setPlatformCloudBranch] = useState("");
  const [platformCloudLimit, setPlatformCloudLimit] = useState("20");
  const [platformCloudCursor, setPlatformCloudCursor] = useState("");
  const [platformCloudAttempt, setPlatformCloudAttempt] = useState("1");
  const [platformCloudResult, setPlatformCloudResult] =
    useState<CodexPlatformResult | null>(null);

  const platformHost = useMemo(
    () => hosts.find((host) => host.id === platformHostID) ?? null,
    [hosts, platformHostID],
  );

  useEffect(() => {
    if (hosts.length === 0) {
      if (platformHostID) {
        setPlatformHostID("");
      }
      return;
    }
    if (platformHostID && hosts.some((host) => host.id === platformHostID)) {
      return;
    }
    if (
      activeWorkspaceHostID &&
      hosts.some((host) => host.id === activeWorkspaceHostID)
    ) {
      setPlatformHostID(activeWorkspaceHostID);
      return;
    }
    setPlatformHostID(hosts[0].id);
  }, [hosts, activeWorkspaceHostID, platformHostID]);

  const { onRunPlatformLogin, onRunPlatformMCP, onRunPlatformCloud } =
    createPlatformActions({
      authPhase,
      token,
      platformHostID,
      platformHostName: platformHost?.name ?? "",
      platformMCPAction,
      platformMCPName,
      platformMCPURL,
      platformMCPCommand,
      platformMCPEnvCSV,
      platformMCPBearerTokenEnvVar,
      platformMCPScopeCSV,
      platformCloudAction,
      platformCloudTaskID,
      platformCloudEnvID,
      platformCloudQuery,
      platformCloudAttempts,
      platformCloudBranch,
      platformCloudLimit,
      platformCloudCursor,
      platformCloudAttempt,
      setPlatformBusySection,
      setPlatformNotice,
      setPlatformLoginResult,
      setPlatformMCPResult,
      setPlatformCloudResult,
    });

  const panelProps: ComponentProps<typeof OpsCodexPlatformPanel> = {
    hosts,
    platformHostID,
    onPlatformHostChange: setPlatformHostID,
    platformBusySection,
    platformNotice,
    onRunPlatformLogin,
    platformLoginResult,
    platformMCPAction,
    onPlatformMCPActionChange: setPlatformMCPAction,
    platformMCPName,
    onPlatformMCPNameChange: setPlatformMCPName,
    platformMCPURL,
    onPlatformMCPURLChange: setPlatformMCPURL,
    platformMCPCommand,
    onPlatformMCPCommandChange: setPlatformMCPCommand,
    platformMCPEnvCSV,
    onPlatformMCPEnvCSVChange: setPlatformMCPEnvCSV,
    platformMCPBearerTokenEnvVar,
    onPlatformMCPBearerTokenEnvVarChange: setPlatformMCPBearerTokenEnvVar,
    platformMCPScopeCSV,
    onPlatformMCPScopeCSVChange: setPlatformMCPScopeCSV,
    onRunPlatformMCP,
    platformMCPResult,
    platformCloudAction,
    onPlatformCloudActionChange: setPlatformCloudAction,
    platformCloudTaskID,
    onPlatformCloudTaskIDChange: setPlatformCloudTaskID,
    platformCloudEnvID,
    onPlatformCloudEnvIDChange: setPlatformCloudEnvID,
    platformCloudQuery,
    onPlatformCloudQueryChange: setPlatformCloudQuery,
    platformCloudAttempts,
    onPlatformCloudAttemptsChange: setPlatformCloudAttempts,
    platformCloudBranch,
    onPlatformCloudBranchChange: setPlatformCloudBranch,
    platformCloudLimit,
    onPlatformCloudLimitChange: setPlatformCloudLimit,
    platformCloudCursor,
    onPlatformCloudCursorChange: setPlatformCloudCursor,
    platformCloudAttempt,
    onPlatformCloudAttemptChange: setPlatformCloudAttempt,
    onRunPlatformCloud,
    platformCloudResult,
  };

  return {
    panelProps,
  };
}
