import type { CodexApprovalPolicy } from "../../domains/session";

export const DEFAULT_WORKSPACE_PATH = "/";
export const EMPTY_ASSISTANT_FALLBACK = "No assistant output captured.";
export const MAX_SESSION_STREAMS = 0;
export const COMPOSER_MIN_HEIGHT = 52;
export const COMPOSER_MAX_HEIGHT = 260;
export const TIMELINE_STICK_GAP_PX = 72;
export const TIMELINE_JUMP_COUNT_CAP = 99;
export const MAX_COMPLETED_RUN_CACHE_SIZE = 2400;

export const APPROVAL_POLICY_OPTIONS: Array<{
  value: CodexApprovalPolicy;
  label: string;
}> = [
  { value: "", label: "default" },
  { value: "untrusted", label: "untrusted" },
  { value: "on-request", label: "on-request" },
  { value: "never", label: "never" },
  { value: "on-failure", label: "on-failure (legacy)" },
];

export type CodexPlatformMCPAction =
  | "list"
  | "get"
  | "add"
  | "remove"
  | "login"
  | "logout";
export type CodexPlatformCloudAction =
  | "list"
  | "status"
  | "exec"
  | "diff"
  | "apply";

export const CODEX_PLATFORM_MCP_ACTIONS: Array<{
  value: CodexPlatformMCPAction;
  label: string;
}> = [
  { value: "list", label: "list" },
  { value: "get", label: "get" },
  { value: "add", label: "add" },
  { value: "remove", label: "remove" },
  { value: "login", label: "login" },
  { value: "logout", label: "logout" },
];

export const CODEX_PLATFORM_CLOUD_ACTIONS: Array<{
  value: CodexPlatformCloudAction;
  label: string;
}> = [
  { value: "list", label: "list" },
  { value: "status", label: "status" },
  { value: "exec", label: "exec" },
  { value: "diff", label: "diff" },
  { value: "apply", label: "apply" },
];
