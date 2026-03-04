import {
  FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  API_BASE,
  cancelRunJob,
  discoverCodexSessions,
  discoverCodexModels,
  archiveSession,
  deleteHost,
  enqueueRunJob,
  getMetrics,
  getRunJob,
  healthz,
  listAudit,
  listHosts,
  listProjects,
  listRunJobEvents,
  listRunJobs,
  listRuns,
  listRuntimes,
  listSessions,
  probeHost,
  runFanout,
  streamSessionEvents,
  uploadImage,
  upsertHost,
  type Host,
  type ProjectRecord,
  type SessionEventRecord,
  type SessionRecord,
  type SessionStreamFrame,
  type RunJobEvent,
  type RunJobRecord,
  type RunRequest,
  type RunResponse,
} from "./api";
import { useOpsDomain } from "./domains/ops";
import { type TimelineEntry, useSessionDomain } from "./domains/session";

const TOKEN_KEY = "remote_llm_access_key";
const SESSION_TREE_PREFS_KEY = "remote_llm_session_tree_prefs_v1";

type AuthPhase = "checking" | "locked" | "ready";
type AppMode = "session" | "ops";

type SessionAlert = {
  id: string;
  threadID: string;
  title: string;
  body: string;
};

type SessionTreeProject = {
  id: string;
  hostID: string;
  path: string;
  sessions: Array<{
    id: string;
    title: string;
    pinned: boolean;
    activeJobID: string;
    unreadDone: boolean;
    lastJobStatus: "idle" | "running" | "succeeded" | "failed" | "canceled";
    updatedAt: string;
  }>;
};

type SessionTreeHost = {
  hostID: string;
  hostName: string;
  hostAddress: string;
  projects: SessionTreeProject[];
};

type SessionRunStreamState = {
  runID: string;
  stdout: string;
  streamSeen: boolean;
  assistantFinalized: boolean;
  failureHints: string[];
};

type SessionStreamHealthState =
  | "offline"
  | "connecting"
  | "live"
  | "reconnecting"
  | "error";

type SessionStreamHealth = {
  state: SessionStreamHealthState;
  retries: number;
  lastEventAt: number;
  updatedAt: number;
  lastError: string;
};

const EMPTY_ASSISTANT_FALLBACK = "No assistant output captured.";
const MESSAGE_COLLAPSE_LINE_LIMIT = 42;
const MAX_SESSION_STREAMS = 4;

type SessionTreePrefs = {
  projectFilter: string;
  collapsedHostIDs: string[];
};

type SessionLastStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

function loadSessionTreePrefs(): SessionTreePrefs {
  if (typeof window === "undefined") {
    return { projectFilter: "", collapsedHostIDs: [] };
  }
  const raw = window.localStorage.getItem(SESSION_TREE_PREFS_KEY);
  if (!raw) return { projectFilter: "", collapsedHostIDs: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<SessionTreePrefs>;
    const projectFilter =
      typeof parsed.projectFilter === "string" ? parsed.projectFilter : "";
    const collapsedHostIDs = Array.isArray(parsed.collapsedHostIDs)
      ? parsed.collapsedHostIDs.filter(
          (item): item is string => typeof item === "string" && item.trim() !== "",
        )
      : [];
    return { projectFilter, collapsedHostIDs };
  } catch {
    return { projectFilter: "", collapsedHostIDs: [] };
  }
}

function isJobActive(job: RunJobRecord | null | undefined): boolean {
  if (!job) return false;
  return job.status === "pending" || job.status === "running";
}

function summarizeRunResponse(response: RunResponse): string {
  const lines = [
    `runtime=${response.runtime}`,
    `total=${response.summary.total} succeeded=${response.summary.succeeded} failed=${response.summary.failed}`,
    `fanout=${response.summary.fanout} duration=${response.summary.duration_ms}ms`,
  ];
  for (const target of response.targets) {
    const status = target.ok ? "ok" : "failed";
    const exit = target.result.exit_code ?? "n/a";
    const hint = target.error_hint ? ` hint=${target.error_hint}` : "";
    const err = target.error ? ` error=${target.error}` : "";
    lines.push(`${target.host.name}: ${status} exit=${exit}${hint}${err}`);
  }
  return lines.join("\n");
}

function summarizeJobEventLine(event: RunJobEvent): string {
  const host = event.host_name || event.host_id || "target";
  switch (event.type) {
    case "target.started":
      return `${host} started.`;
    case "target.done":
      if ((event.status ?? "").toLowerCase() === "ok") {
        return `${host} completed.`;
      }
      return [
        host,
        "failed",
        typeof event.exit_code === "number" ? `exit ${event.exit_code}` : "",
        event.error || "",
      ]
        .filter((part) => part.trim() !== "")
        .join(" · ");
    case "job.cancel_requested":
      return "Cancel requested.";
    case "job.canceled":
      return "Session canceled.";
    case "job.failed":
      return event.error ? `Session failed: ${event.error}` : "Session failed.";
    case "job.succeeded":
      return "Session completed.";
    default:
      return "";
  }
}

function sessionCompletionCopy(status: "succeeded" | "failed" | "canceled"): {
  suffix: string;
  body: string;
} {
  switch (status) {
    case "succeeded":
      return { suffix: "completed", body: "New response is ready." };
    case "failed":
      return {
        suffix: "failed",
        body: "Response failed. Open this session for details.",
      };
    case "canceled":
      return { suffix: "canceled", body: "Response was canceled." };
    default:
      return { suffix: "updated", body: "Session status changed." };
  }
}

function normalizeSessionTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (/^session(\s+\d+)?$/i.test(collapsed)) return "";
  if (collapsed.length <= 72) return collapsed;
  return `${collapsed.slice(0, 69).trimEnd()}...`;
}

function isGenericSessionTitle(title: string): boolean {
  return /^session(\s+\d+)?$/i.test(title.trim());
}

function deriveSessionTitleFromPrompt(prompt: string): string {
  const normalized = prompt
    .replace(/[`*_#>\[\]\(\){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  const sentenceMatch = normalized.match(/^(.{1,88}?)([.!?。！？]|$)/);
  const sentence = (sentenceMatch?.[1] ?? normalized).trim();
  const words = sentence.split(" ").filter((word) => word.trim() !== "");
  const compact = words.slice(0, 10).join(" ");
  return normalizeSessionTitle(compact);
}

function clipStreamText(raw: string, maxChars = 3600): string {
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(raw.length - maxChars)}\n...[stream truncated for UI]...`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function gatherMessageText(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      out.push(...gatherMessageText(item, depth + 1));
    }
    return out;
  }

  const record = asRecord(value);
  if (!record) return [];
  const out: string[] = [];
  const keys = ["text", "message", "content", "parts", "output_text"];
  for (const key of keys) {
    if (!(key in record)) continue;
    out.push(...gatherMessageText(record[key], depth + 1));
  }
  return out;
}

function pickAssistantTextFromEvent(event: Record<string, unknown>): string {
  const eventType = typeof event.type === "string" ? event.type : "";
  if (eventType === "item.completed") {
    const item = asRecord(event.item);
    if (!item) return "";
    const itemType = typeof item.type === "string" ? item.type : "";
    const itemRole = typeof item.role === "string" ? item.role : "";
    if (
      itemType !== "" &&
      itemType !== "agent_message" &&
      itemType !== "assistant_message" &&
      itemType !== "message" &&
      itemRole !== "assistant"
    ) {
      return "";
    }
    return gatherMessageText(item).join("\n").trim();
  }

  if (eventType === "response.completed") {
    const response = asRecord(event.response);
    if (!response) return "";
    return gatherMessageText(response).join("\n").trim();
  }

  return "";
}

function isProtocolNoiseLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return true;
  if (/^done\.?$/i.test(normalized)) return true;
  if (normalized.includes(`"type":"thread.started"`)) return true;
  if (normalized.includes(`"type":"turn.started"`)) return true;
  if (normalized.includes(`"type":"turn.completed"`)) return true;
  if (normalized.includes(`"type":"response.started"`)) return true;
  return false;
}

function parseCodexAssistantTextFromStdout(
  stdout: string,
  allowPlainTextFallback = true,
): string {
  if (!stdout.trim()) return "";
  const lines = stdout.split(/\r?\n/);
  const messages: string[] = [];
  const deltas: string[] = [];
  const plainLines: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (!isProtocolNoiseLine(line)) {
        plainLines.push(line);
      }
      continue;
    }
    const event = asRecord(parsed);
    if (!event) continue;
    const eventType = typeof event.type === "string" ? event.type : "";
    if (eventType.endsWith(".delta")) {
      const deltaText = gatherMessageText(event.delta ?? event).join("");
      if (deltaText.trim()) {
        deltas.push(deltaText);
      }
    }
    const text = pickAssistantTextFromEvent(event);
    if (!text) continue;
    if (!messages.includes(text)) {
      messages.push(text);
    }
  }
  if (messages.length > 0) {
    return messages[messages.length - 1] ?? "";
  }
  if (deltas.length > 0) {
    return deltas.join("").trim();
  }
  if (allowPlainTextFallback && plainLines.length > 0) {
    return plainLines.join("\n").trim();
  }
  return "";
}

function pickSessionTitleFromEvent(event: Record<string, unknown>): string {
  const direct = normalizeSessionTitle(
    typeof event.title === "string" ? event.title : "",
  );
  if (direct) return direct;
  const nestedKeys = ["thread", "session", "payload", "item", "data", "meta"];
  for (const key of nestedKeys) {
    const record = asRecord(event[key]);
    if (!record) continue;
    const title = normalizeSessionTitle(
      typeof record.title === "string" ? record.title : "",
    );
    if (title) return title;
  }
  return "";
}

function parseCodexSessionTitleFromStdout(stdout: string): string {
  if (!stdout.trim()) return "";
  const lines = stdout.split(/\r?\n/);
  let latest = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = asRecord(parsed);
    if (!event) continue;
    const eventType =
      typeof event.type === "string" ? event.type.toLowerCase() : "";
    if (eventType.includes("title")) {
      const titled = pickSessionTitleFromEvent(event);
      if (titled) latest = titled;
      continue;
    }
    if (eventType === "thread.started" || eventType === "session.started") {
      const titled = pickSessionTitleFromEvent(event);
      if (titled) latest = titled;
    }
  }
  return latest;
}

function extractAssistantTextFromJob(job: RunJobRecord): string {
  const response = job.response;
  if (
    !response ||
    !("targets" in response) ||
    !Array.isArray(response.targets) ||
    response.targets.length === 0
  ) {
    return "";
  }
  const targetMessages: string[] = [];
  const multiTarget = response.targets.length > 1;
  for (const target of response.targets) {
    const stdout = target?.result?.stdout;
    if (typeof stdout !== "string" || !stdout.trim()) continue;
    const assistantText =
      parseCodexAssistantTextFromStdout(stdout, false) ||
      parseCodexAssistantTextFromStdout(stdout, true);
    if (!assistantText) continue;
    if (multiTarget) {
      const hostName = target.host?.name?.trim() || target.host?.id || "target";
      targetMessages.push(`[${hostName}] ${assistantText}`);
    } else {
      targetMessages.push(assistantText);
    }
  }
  return targetMessages.join("\n\n").trim();
}

function jobHasTargetFailures(job: RunJobRecord): boolean {
  const response = job.response;
  if (!response || !("summary" in response) || !("targets" in response))
    return false;
  const failedCount =
    typeof response.summary?.failed === "number" ? response.summary.failed : 0;
  if (failedCount > 0) return true;
  if (!Array.isArray(response.targets)) return false;
  return response.targets.some((target) => target?.ok === false);
}

function summarizeTargetFailures(job: RunJobRecord): string {
  const response = job.response;
  if (!response || !("targets" in response) || !Array.isArray(response.targets))
    return "";
  const lines: string[] = [];
  for (const target of response.targets) {
    if (target?.ok !== false) continue;
    const hostName = target.host?.name?.trim() || target.host?.id || "target";
    const parts = [`${hostName} failed`];
    if (target.error) parts.push(`error=${target.error}`);
    if (target.error_hint) parts.push(`hint=${target.error_hint}`);
    if (
      typeof target.result?.stderr === "string" &&
      target.result.stderr.trim()
    ) {
      parts.push(`stderr=${clipStreamText(target.result.stderr.trim(), 1000)}`);
    }
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

function formatClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(ts: string | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function compactPath(path: string, keepSegments = 2): string {
  const normalized = path.trim();
  if (!normalized) return "/";
  const segments = normalized.split("/").filter((part) => part.trim() !== "");
  if (segments.length <= keepSegments) {
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }
  const tail = segments.slice(-keepSegments).join("/");
  return `.../${tail}`;
}

type MessageSegment =
  | {
      kind: "text";
      content: string;
    }
  | {
      kind: "code";
      lang: string;
      content: string;
    };

function parseMessageSegments(raw: string): MessageSegment[] {
  const body = raw ?? "";
  if (!body.trim()) {
    return [{ kind: "text", content: "" }];
  }
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  const segments: MessageSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(fencePattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      const text = body.slice(cursor, start);
      if (text.length > 0) {
        segments.push({ kind: "text", content: text });
      }
    }
    const lang = (match[1] ?? "").trim();
    const code = (match[2] ?? "").replace(/\n$/, "");
    segments.push({ kind: "code", lang, content: code });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) {
    const tail = body.slice(cursor);
    if (tail.length > 0) {
      segments.push({ kind: "text", content: tail });
    }
  }
  if (segments.length === 0) {
    segments.push({ kind: "text", content: body });
  }
  return segments;
}

function shouldCollapseMessageBody(raw: string): boolean {
  if (!raw.trim()) return false;
  const lines = raw.split(/\r?\n/);
  if (lines.length > MESSAGE_COLLAPSE_LINE_LIMIT) return true;
  return raw.length > 7000;
}

function statusTone(status: string): "ok" | "warn" | "err" {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "canceled") return "err";
  return "warn";
}

function modeFromHash(hash: string): AppMode {
  return hash === "#/ops" ? "ops" : "session";
}

function modeToHash(mode: AppMode): string {
  return mode === "ops" ? "#/ops" : "#/session";
}

function streamHealthTone(
  state: SessionStreamHealthState,
): "ok" | "warn" | "error" {
  if (state === "live") return "ok";
  if (state === "error") return "error";
  if (state === "offline") return "warn";
  return "warn";
}

function streamHealthCopy(
  state: SessionStreamHealthState,
  retries: number,
): string {
  if (state === "live") return "live";
  if (state === "connecting") return "connecting";
  if (state === "reconnecting")
    return retries > 0 ? `reconnecting (${retries})` : "reconnecting";
  if (state === "error")
    return retries > 0 ? `stream error (${retries})` : "stream error";
  return "offline";
}

export function App() {
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState<string>(
    () => localStorage.getItem(TOKEN_KEY) ?? "",
  );
  const [authError, setAuthError] = useState("");
  const [appMode, setAppMode] = useState<AppMode>(() =>
    typeof window === "undefined"
      ? "session"
      : modeFromHash(window.location.hash),
  );

  const ops = useOpsDomain();
  const session = useSessionDomain();

  const {
    health,
    setHealth,
    hosts,
    setHosts,
    runtimes,
    setRuntimes,
    jobs,
    setJobs,
    runs,
    setRuns,
    auditEvents,
    setAuditEvents,
    metrics,
    setMetrics,
    selectedRuntime,
    setSelectedRuntime,
    allHosts,
    setAllHosts,
    selectedHostIDs,
    setSelectedHostIDs,
    runSandbox,
    setRunSandbox,
    runAsyncMode,
    setRunAsyncMode,
    fanoutValue,
    maxOutputKB,
    isRefreshing,
    setIsRefreshing,
    activeJobID,
    setActiveJobID,
    activeJob,
    setActiveJob,
    hostForm,
    setHostForm,
    hostFilter,
    setHostFilter,
    editingHostID,
    setEditingHostID,
    addingHost,
    setAddingHost,
    opsHostBusyID,
    setOpsHostBusyID,
    opsNotice,
    setOpsNotice,
    opsJobStatusFilter,
    setOpsJobStatusFilter,
    opsJobTypeFilter,
    setOpsJobTypeFilter,
    opsRunStatusFilter,
    setOpsRunStatusFilter,
    opsAuditMethodFilter,
    setOpsAuditMethodFilter,
    opsAuditStatusFilter,
    setOpsAuditStatusFilter,
    resetOpsDomain,
  } = ops;

  const {
    workspaces,
    activeWorkspace,
    activeWorkspaceID,
    setActiveWorkspaceID,
    threads,
    activeThreadID,
    activateThread,
    activeJobThreadID,
    setActiveJobThreadID,
    completedJobsRef,
    activeThread,
    activeTimeline,
    activeDraft,
    updateThreadDraft,
    addTimelineEntry,
    upsertAssistantStreamEntry,
    finalizeAssistantStreamEntry,
    createThread,
    removeThread,
    switchThreadByOffset,
    setThreadModel,
    setThreadSandbox,
    addThreadImagePath,
    removeThreadImagePath,
    setThreadJobState,
    setThreadUnread,
    setThreadTitle,
    setThreadPinned,
    runningThreadJobs,
    syncProjectsFromDiscovery,
    resetSessionDomain,
  } = session;

  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>(
      typeof Notification === "undefined" ? "denied" : Notification.permission,
    );
  const [sessionAlerts, setSessionAlerts] = useState<SessionAlert[]>([]);
  const [sessionAlertsExpanded, setSessionAlertsExpanded] = useState(true);
  const [sessionStreamHealthByID, setSessionStreamHealthByID] = useState<
    Record<string, SessionStreamHealth>
  >({});
  const [submittingThreadID, setSubmittingThreadID] = useState("");
  const [deletingThreadID, setDeletingThreadID] = useState("");
  const [sessionModelDefault, setSessionModelDefault] = useState("");
  const [sessionModelOptions, setSessionModelOptions] = useState<string[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageUploadError, setImageUploadError] = useState("");
  const sessionTreePrefs = useMemo(() => loadSessionTreePrefs(), []);
  const [projectFilter, setProjectFilter] = useState(sessionTreePrefs.projectFilter);
  const [collapsedHostIDs, setCollapsedHostIDs] = useState<string[]>(
    sessionTreePrefs.collapsedHostIDs,
  );
  const [treeCursorSessionID, setTreeCursorSessionID] = useState("");
  const [expandedMessageIDs, setExpandedMessageIDs] = useState<string[]>([]);
  const [copiedCodeKey, setCopiedCodeKey] = useState("");

  const timelineViewportRef = useRef<HTMLElement | null>(null);
  const timelineBottomRef = useRef<HTMLDivElement | null>(null);
  const timelineStickToBottomRef = useRef(true);
  const timelineForceStickRef = useRef(false);
  const lastTimelineThreadIDRef = useRef("");
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const copyResetTimerRef = useRef<number | null>(null);
  const jobEventCursorRef = useRef<Map<string, number>>(new Map());
  const jobStreamSeenRef = useRef<Map<string, boolean>>(new Map());
  const jobNoTextFinalizeRetriesRef = useRef<Map<string, number>>(new Map());
  const sessionEventCursorRef = useRef<Map<string, number>>(new Map());
  const sessionStreamStateRef = useRef<
    Map<
      string,
      { controller: AbortController; ready: boolean; lastEventAt: number }
    >
  >(new Map());
  const sessionRunStateRef = useRef<Map<string, SessionRunStreamState>>(
    new Map(),
  );
  const streamAuthTokenRef = useRef("");
  const completionAlertCutoffMSRef = useRef<number>(Date.now());
  const activeThreadIDRef = useRef(activeThreadID);
  const threadTitleMapRef = useRef<Map<string, string>>(new Map());
  const threadWorkspaceMapRef = useRef<Map<string, string>>(new Map());
  const runningSessionIDsRef = useRef<Set<string>>(new Set());
  const previousAlertCountRef = useRef(0);
  const tokenRef = useRef(token);

  const activeRuntime = useMemo(
    () =>
      runtimes.find((runtime) => runtime.name === selectedRuntime) ??
      runtimes[0] ??
      null,
    [runtimes, selectedRuntime],
  );
  const activeSessionStreamHealth = activeThreadID
    ? sessionStreamHealthByID[activeThreadID]
    : undefined;
  const selectedHostCount = allHosts ? hosts.length : selectedHostIDs.length;
  const threadWorkspaceMap = useMemo(() => {
    const out = new Map<string, string>();
    for (const workspace of workspaces) {
      for (const thread of workspace.sessions) {
        out.set(thread.id, workspace.id);
      }
    }
    return out;
  }, [workspaces]);
  const threadTitleMap = useMemo(() => {
    const out = new Map<string, string>();
    for (const workspace of workspaces) {
      for (const thread of workspace.sessions) {
        out.set(thread.id, thread.title);
      }
    }
    return out;
  }, [workspaces]);
  const sessionStreamTargetIDs = useMemo(() => {
    type StreamTarget = {
      id: string;
      priority: number;
      updatedAtMS: number;
    };
    const byID = new Map<string, StreamTarget>();
    const touch = (idRaw: string, priority: number, updatedAtRaw: string) => {
      const id = idRaw.trim();
      if (!id) return;
      const parsed = Date.parse(updatedAtRaw);
      const updatedAtMS = Number.isFinite(parsed) ? parsed : 0;
      const existing = byID.get(id);
      if (
        !existing ||
        priority < existing.priority ||
        (priority === existing.priority && updatedAtMS > existing.updatedAtMS)
      ) {
        byID.set(id, { id, priority, updatedAtMS });
      }
    };

    for (const workspace of workspaces) {
      for (const thread of workspace.sessions) {
        const priority = thread.id === activeThreadID
          ? 0
          : thread.activeJobID.trim()
            ? 1
            : thread.pinned
              ? 2
              : thread.unreadDone
                ? 3
                : 9;
        touch(thread.id, priority, thread.updatedAt);
      }
    }

    const ordered = Array.from(byID.values()).sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      if (left.updatedAtMS !== right.updatedAtMS) {
        return right.updatedAtMS - left.updatedAtMS;
      }
      return left.id.localeCompare(right.id);
    });

    const pinned = ordered.filter((item) => item.priority <= 3);
    if (pinned.length >= MAX_SESSION_STREAMS) {
      return pinned.slice(0, MAX_SESSION_STREAMS).map((item) => item.id);
    }

    const chosen = [...pinned];
    const chosenIDs = new Set(chosen.map((item) => item.id));
    for (const item of ordered) {
      if (chosenIDs.has(item.id)) continue;
      chosen.push(item);
      chosenIDs.add(item.id);
      if (chosen.length >= MAX_SESSION_STREAMS) break;
    }
    return chosen.map((item) => item.id);
  }, [workspaces, activeThreadID]);
  const activeSessionHostID = activeWorkspace?.hostID?.trim() ?? "";
  const sessionTreeHosts = useMemo<SessionTreeHost[]>(() => {
    const hostLookup = new Map<string, Host>();
    for (const host of hosts) {
      hostLookup.set(host.id, host);
    }

    const groups = new Map<string, SessionTreeHost>();
    for (const workspace of workspaces) {
      const hostID = workspace.hostID?.trim() || "unknown";
      const host = hostLookup.get(hostID);
      const group = groups.get(hostID) ?? {
        hostID,
        hostName: workspace.hostName || host?.name || hostID,
        hostAddress: host
          ? `${host.user ? `${host.user}@` : ""}${host.host}:${host.port}`
          : "",
        projects: [],
      };

      const project: SessionTreeProject = {
        id: workspace.id,
        hostID,
        path: workspace.path,
        sessions: [...workspace.sessions]
          .sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            if (a.unreadDone !== b.unreadDone) return a.unreadDone ? -1 : 1;
            const aRunning = a.activeJobID.trim() !== "";
            const bRunning = b.activeJobID.trim() !== "";
            if (aRunning !== bRunning) return aRunning ? -1 : 1;
            const aTS = Date.parse(a.updatedAt);
            const bTS = Date.parse(b.updatedAt);
            const safeA = Number.isFinite(aTS) ? aTS : 0;
            const safeB = Number.isFinite(bTS) ? bTS : 0;
            if (safeA !== safeB) return safeB - safeA;
            return a.title.localeCompare(b.title);
          })
          .map((sessionItem) => ({
            id: sessionItem.id,
            title: sessionItem.title,
            pinned: Boolean(sessionItem.pinned),
            activeJobID: sessionItem.activeJobID,
            unreadDone: sessionItem.unreadDone,
            lastJobStatus: sessionItem.lastJobStatus,
            updatedAt: sessionItem.updatedAt,
          })),
      };

      group.projects.push(project);
      groups.set(hostID, group);
    }

    return Array.from(groups.values()).map((group) => ({
      ...group,
      projects: group.projects.sort((a, b) => a.path.localeCompare(b.path)),
    }));
  }, [hosts, workspaces]);
  const filteredSessionTreeHosts = useMemo<SessionTreeHost[]>(() => {
    const query = projectFilter.trim().toLowerCase();
    if (!query) return sessionTreeHosts;
    const nextHosts: SessionTreeHost[] = [];
    for (const host of sessionTreeHosts) {
      const hostText = `${host.hostName} ${host.hostAddress}`.toLowerCase();
      if (hostText.includes(query)) {
        nextHosts.push(host);
        continue;
      }
      const projects: SessionTreeProject[] = [];
      for (const project of host.projects) {
        const projectText = project.path.toLowerCase();
        if (projectText.includes(query)) {
          projects.push(project);
          continue;
        }
        const sessions = project.sessions.filter((sessionItem) => {
          const text = `${sessionItem.title} ${sessionItem.id}`.toLowerCase();
          return text.includes(query);
        });
        if (sessions.length === 0) continue;
        projects.push({
          ...project,
          sessions,
        });
      }
      if (projects.length === 0) continue;
      nextHosts.push({
        ...host,
        projects,
      });
    }
    return nextHosts;
  }, [projectFilter, sessionTreeHosts]);
  const visibleTreeSessionIDs = useMemo(() => {
    const out: string[] = [];
    for (const hostNode of filteredSessionTreeHosts) {
      if (collapsedHostIDs.includes(hostNode.hostID)) continue;
      for (const projectNode of hostNode.projects) {
        for (const sessionNode of projectNode.sessions) {
          out.push(sessionNode.id);
        }
      }
    }
    return out;
  }, [collapsedHostIDs, filteredSessionTreeHosts]);
  const activeThreadBusy =
    Boolean(activeThread?.activeJobID) ||
    (activeThread ? submittingThreadID === activeThread.id : false) ||
    (activeThread ? deletingThreadID === activeThread.id : false);
  const activeThreadStatusCopy = activeThreadBusy
    ? "Codex is thinking..."
    : activeThread?.lastJobStatus === "failed"
      ? "Last response failed."
      : activeThread?.lastJobStatus === "canceled"
        ? "Last response interrupted."
        : "";
  const activeStreamState: SessionStreamHealthState = activeSessionStreamHealth
    ? activeSessionStreamHealth.state
    : activeThreadID
      ? "connecting"
      : "offline";
  const activeStreamRetries = activeSessionStreamHealth?.retries ?? 0;
  const activeStreamCopy = streamHealthCopy(activeStreamState, activeStreamRetries);
  const activeStreamTone = streamHealthTone(activeStreamState);
  const activeStreamLastError =
    activeSessionStreamHealth?.lastError.trim() ?? "";
  const canReconnectActiveStream =
    authPhase === "ready" && token.trim() !== "" && activeThreadID.trim() !== "";
  const activeThreadModelValue = useMemo(() => {
    const current = activeThread?.model.trim() ?? "";
    if (current) return current;
    if (sessionModelDefault.trim()) return sessionModelDefault.trim();
    return sessionModelOptions[0]?.trim() ?? "";
  }, [activeThread?.model, sessionModelDefault, sessionModelOptions]);
  const sessionModelChoices = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (modelName: string) => {
      const trimmed = modelName.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      out.push(trimmed);
    };
    push(sessionModelDefault);
    for (const modelName of sessionModelOptions) push(modelName);
    if (activeThreadModelValue) push(activeThreadModelValue);
    return out;
  }, [sessionModelDefault, sessionModelOptions, activeThreadModelValue]);
  const hasSessionModelChoices = sessionModelChoices.length > 0;
  const activeTimelineTail = activeTimeline[activeTimeline.length - 1];

  const activeProgress = useMemo(() => {
    if (!activeJob) return 0;
    const total = activeJob.total_hosts ?? 0;
    if (total <= 0) return isJobActive(activeJob) ? 0 : 100;
    const done =
      (activeJob.succeeded_hosts ?? 0) + (activeJob.failed_hosts ?? 0);
    if (!isJobActive(activeJob)) return 100;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }, [activeJob]);

  const filteredOpsJobs = useMemo(() => {
    const byStatus =
      opsJobStatusFilter === "all"
        ? jobs
        : jobs.filter((job) => job.status === opsJobStatusFilter);
    if (opsJobTypeFilter === "all") return byStatus;
    return byStatus.filter((job) => job.type === opsJobTypeFilter);
  }, [jobs, opsJobStatusFilter, opsJobTypeFilter]);

  const filteredHosts = useMemo(() => {
    const query = hostFilter.trim().toLowerCase();
    if (!query) return hosts;
    return hosts.filter((host) => {
      const text =
        `${host.name} ${host.host} ${host.user} ${host.workspace ?? ""} ${host.connection_mode ?? "ssh"}`.toLowerCase();
      return text.includes(query);
    });
  }, [hosts, hostFilter]);

  const filteredOpsRuns = useMemo(() => {
    if (opsRunStatusFilter === "all") return runs;
    if (opsRunStatusFilter === "ok")
      return runs.filter((run) => run.status_code < 400);
    return runs.filter((run) => run.status_code >= 400);
  }, [runs, opsRunStatusFilter]);

  const filteredAuditEvents = useMemo(() => {
    return auditEvents.filter((evt) => {
      if (opsAuditMethodFilter !== "all" && evt.method !== opsAuditMethodFilter)
        return false;
      if (
        opsAuditStatusFilter === "2xx" &&
        (evt.status_code < 200 || evt.status_code >= 300)
      )
        return false;
      if (
        opsAuditStatusFilter === "4xx" &&
        (evt.status_code < 400 || evt.status_code >= 500)
      )
        return false;
      if (
        opsAuditStatusFilter === "5xx" &&
        (evt.status_code < 500 || evt.status_code >= 600)
      )
        return false;
      return true;
    });
  }, [auditEvents, opsAuditMethodFilter, opsAuditStatusFilter]);
  const healthIsError = health.startsWith("error");
  const opsNoticeIsError = /fail|error|degraded/i.test(opsNotice);
  const syncLabel = isRefreshing ? "syncing" : "live";

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    activeThreadIDRef.current = activeThreadID;
  }, [activeThreadID]);

  useEffect(() => {
    threadTitleMapRef.current = threadTitleMap;
  }, [threadTitleMap]);

  useEffect(() => {
    threadWorkspaceMapRef.current = threadWorkspaceMap;
  }, [threadWorkspaceMap]);

  useEffect(() => {
    const running = new Set<string>();
    for (const workspace of workspaces) {
      for (const sessionItem of workspace.sessions) {
        if (sessionItem.activeJobID.trim()) {
          running.add(sessionItem.id);
        }
      }
    }
    runningSessionIDsRef.current = running;
  }, [workspaces]);

  useEffect(() => {
    if (sessionAlerts.length > previousAlertCountRef.current) {
      setSessionAlertsExpanded(true);
    }
    previousAlertCountRef.current = sessionAlerts.length;
  }, [sessionAlerts.length]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const title = activeThread?.title.trim() || "Session";
    document.title = `${title} · Codex Control App`;
  }, [activeThread?.title]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const runningSessionIDs = new Set<string>();
      for (const workspace of workspaces) {
        for (const thread of workspace.sessions) {
          if (thread.activeJobID.trim()) {
            runningSessionIDs.add(thread.id);
          }
        }
      }
      for (const [sessionID, state] of sessionStreamStateRef.current.entries()) {
        if (!runningSessionIDs.has(sessionID)) continue;
        if (state.lastEventAt <= 0) continue;
        if (now - state.lastEventAt < 16_000) continue;
        updateSessionStreamHealth(sessionID, "reconnecting", {
          lastEventAt: state.lastEventAt,
          lastError: "stream idle, retrying",
          throttleMS: 0,
        });
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [workspaces]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload: SessionTreePrefs = {
      projectFilter,
      collapsedHostIDs,
    };
    window.localStorage.setItem(SESSION_TREE_PREFS_KEY, JSON.stringify(payload));
  }, [projectFilter, collapsedHostIDs]);

  useEffect(() => {
    if (sessionTreeHosts.length === 0) return;
    const validHostIDs = new Set(sessionTreeHosts.map((item) => item.hostID));
    setCollapsedHostIDs((prev) => {
      const next = prev.filter((hostID) => validHostIDs.has(hostID));
      return next.length === prev.length ? prev : next;
    });
  }, [sessionTreeHosts]);

  useEffect(() => {
    if (activeThreadID.trim()) {
      setTreeCursorSessionID(activeThreadID);
    }
  }, [activeThreadID]);

  useEffect(() => {
    if (visibleTreeSessionIDs.length === 0) {
      setTreeCursorSessionID("");
      return;
    }
    setTreeCursorSessionID((prev) =>
      prev && visibleTreeSessionIDs.includes(prev) ? prev : visibleTreeSessionIDs[0],
    );
  }, [visibleTreeSessionIDs]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  function createThreadAndFocus() {
    createThread();
    promptInputRef.current?.focus();
  }

  function registerSessionButtonRef(
    sessionID: string,
    node: HTMLButtonElement | null,
  ) {
    if (!sessionID) return;
    if (node) {
      sessionButtonRefs.current.set(sessionID, node);
      return;
    }
    sessionButtonRefs.current.delete(sessionID);
  }

  function moveTreeCursor(step: number) {
    if (visibleTreeSessionIDs.length === 0) return;
    const currentIndex = Math.max(
      0,
      visibleTreeSessionIDs.findIndex((id) => id === treeCursorSessionID),
    );
    const nextIndex =
      (currentIndex + step + visibleTreeSessionIDs.length) %
      visibleTreeSessionIDs.length;
    const nextID = visibleTreeSessionIDs[nextIndex];
    setTreeCursorSessionID(nextID);
    const node = sessionButtonRefs.current.get(nextID);
    node?.focus();
  }

  function onSessionTreeKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    sessionID: string,
    pinned: boolean,
  ) {
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
      const nextID = visibleTreeSessionIDs[0];
      if (!nextID) return;
      setTreeCursorSessionID(nextID);
      sessionButtonRefs.current.get(nextID)?.focus();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const nextID = visibleTreeSessionIDs[visibleTreeSessionIDs.length - 1];
      if (!nextID) return;
      setTreeCursorSessionID(nextID);
      sessionButtonRefs.current.get(nextID)?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setTreeCursorSessionID(sessionID);
      activateThread(sessionID);
      return;
    }
    if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      setThreadPinned(sessionID, !pinned);
    }
  }

  function toggleMessageExpanded(entryID: string) {
    setExpandedMessageIDs((prev) =>
      prev.includes(entryID)
        ? prev.filter((id) => id !== entryID)
        : [...prev, entryID],
    );
  }

  async function copyToClipboard(content: string, key: string) {
    const text = content ?? "";
    if (!text) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.focus();
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setCopiedCodeKey(key);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedCodeKey("");
      }, 1500);
    } catch {
      setCopiedCodeKey("");
    }
  }

  function renderTimelineEntryBody(entry: TimelineEntry) {
    const segments = parseMessageSegments(entry.body);
    const collapsible = shouldCollapseMessageBody(entry.body);
    const expanded = expandedMessageIDs.includes(entry.id);
    const showCollapsed = collapsible && !expanded;
    const wrapperClass = `message-body${showCollapsed ? " message-body-collapsed" : ""}`;
    return (
      <div className={wrapperClass}>
        {segments.map((segment, index) =>
          segment.kind === "text" ? (
            <pre key={`${entry.id}_text_${index}`}>{segment.content}</pre>
          ) : (
            <section key={`${entry.id}_code_${index}`} className="message-code-block">
              <header className="message-code-head">
                <span>{segment.lang || "code"}</span>
                <button
                  type="button"
                  className="ghost code-copy-btn"
                  onClick={() => void copyToClipboard(segment.content, `${entry.id}_${index}`)}
                >
                  {copiedCodeKey === `${entry.id}_${index}` ? "Copied" : "Copy"}
                </button>
              </header>
              <pre className="message-code-pre">{segment.content}</pre>
            </section>
          ),
        )}
        {showCollapsed ? <div className="message-collapse-mask" aria-hidden="true" /> : null}
        {collapsible ? (
          <div className="message-collapse-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => toggleMessageExpanded(entry.id)}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  function toggleHostCollapsed(hostID: string) {
    setCollapsedHostIDs((prev) =>
      prev.includes(hostID)
        ? prev.filter((id) => id !== hostID)
        : [...prev, hostID],
    );
  }

  function notifySessionDone(title: string, body: string) {
    if (typeof Notification === "undefined") return;
    if (notificationPermission !== "granted") return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    ) {
      return;
    }
    try {
      const note = new Notification(title, { body, silent: false });
      window.setTimeout(() => note.close(), 6000);
    } catch {
      // Notification failures are non-fatal for session completion flow.
    }
  }

  function shouldSurfaceCompletion(createdAt?: string): boolean {
    const ts = createdAt?.trim();
    if (!ts) return false;
    const parsed = Date.parse(ts);
    if (!Number.isFinite(parsed)) return false;
    return parsed >= completionAlertCutoffMSRef.current;
  }

  function pushSessionAlert(alert: Omit<SessionAlert, "id">) {
    const id = `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const next: SessionAlert = { id, ...alert };
    setSessionAlerts((prev) => {
      const duplicate = prev.some(
        (item) =>
          item.threadID === next.threadID &&
          item.title === next.title &&
          item.body === next.body,
      );
      if (duplicate) return prev;
      const withNext = [...prev, next];
      if (withNext.length <= 24) return withNext;
      return withNext.slice(withNext.length - 24);
    });
  }

  function dismissSessionAlert(alertID: string) {
    setSessionAlerts((prev) => prev.filter((item) => item.id !== alertID));
  }

  function clearSessionAlerts() {
    setSessionAlerts([]);
  }

  function updateSessionStreamHealth(
    sessionID: string,
    state: SessionStreamHealthState,
    options?: {
      retries?: number;
      lastEventAt?: number;
      lastError?: string;
      throttleMS?: number;
    },
  ) {
    const id = sessionID.trim();
    if (!id) return;
    setSessionStreamHealthByID((prev) => {
      const current = prev[id] ?? {
        state: "offline",
        retries: 0,
        lastEventAt: 0,
        updatedAt: 0,
        lastError: "",
      };
      const retries = options?.retries ?? current.retries;
      const lastEventAt = options?.lastEventAt ?? current.lastEventAt;
      const lastError = options?.lastError ?? current.lastError;
      const now = Date.now();
      const throttleMS = options?.throttleMS ?? 1100;
      const stateChanged =
        current.state !== state ||
        current.retries !== retries ||
        current.lastError !== lastError;
      const eventAtChanged = current.lastEventAt !== lastEventAt;
      if (
        !stateChanged &&
        (!eventAtChanged || now - current.updatedAt < throttleMS)
      ) {
        return prev;
      }
      const next: SessionStreamHealth = {
        state,
        retries,
        lastEventAt,
        updatedAt: now,
        lastError,
      };
      return {
        ...prev,
        [id]: next,
      };
    });
  }

  function clearSessionStreamHealth(sessionID: string) {
    const id = sessionID.trim();
    if (!id) return;
    setSessionStreamHealthByID((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function openSessionFromAlert(alert: SessionAlert) {
    if (threadWorkspaceMap.has(alert.threadID)) {
      activateThread(alert.threadID);
      switchMode("session");
    }
    dismissSessionAlert(alert.id);
  }

  async function onEnableNotifications() {
    if (typeof Notification === "undefined") {
      setNotificationPermission("denied");
      return;
    }
    const result = await Notification.requestPermission();
    setNotificationPermission(result);
  }

  async function ensureLocalCodexHost(
    authToken: string,
    currentHosts: Host[],
  ): Promise<Host[]> {
    if (currentHosts.some((host) => host.connection_mode === "local")) {
      return currentHosts;
    }
    await upsertHost(authToken, {
      name: "local-default",
      connection_mode: "local",
      host: "localhost",
      workspace: activeWorkspace?.path?.trim() || "/home/ecs-user",
    });
    return listHosts(authToken);
  }

  function buildDiscoveredProjects(
    sourceHosts: Host[],
    targets: Array<{
      host: Host;
      ok: boolean;
      sessions?: Array<{
        session_id: string;
        cwd?: string;
        thread_name?: string;
        updated_at: string;
      }>;
    }>,
  ) {
    const hostMap = new Map<string, Host>();
    for (const host of sourceHosts) hostMap.set(host.id, host);

    const grouped = new Map<
      string,
      Map<string, Array<{ id: string; title: string; updatedAt?: string }>>
    >();
    for (const target of targets) {
      const hostID = target.host?.id?.trim();
      if (!hostID) continue;
      if (!grouped.has(hostID)) grouped.set(hostID, new Map());
      const pathMap = grouped.get(hostID)!;
      const sessions = Array.isArray(target.sessions) ? target.sessions : [];
      for (const sessionItem of sessions) {
        const projectPath =
          sessionItem.cwd?.trim() ||
          target.host.workspace?.trim() ||
          hostMap.get(hostID)?.workspace?.trim() ||
          "/home/ecs-user";
        if (!pathMap.has(projectPath)) pathMap.set(projectPath, []);
        pathMap.get(projectPath)!.push({
          id: sessionItem.session_id,
          title: sessionItem.thread_name?.trim() || sessionItem.session_id,
          updatedAt: sessionItem.updated_at,
        });
      }
      if (sessions.length === 0) {
        const fallbackPath =
          target.host.workspace?.trim() ||
          hostMap.get(hostID)?.workspace?.trim();
        if (fallbackPath && !pathMap.has(fallbackPath)) {
          pathMap.set(fallbackPath, []);
        }
      }
    }

    const projects: Array<{
      hostID: string;
      hostName: string;
      path: string;
      sessions: Array<{ id: string; title: string; updatedAt?: string }>;
    }> = [];
    for (const [hostID, pathMap] of grouped.entries()) {
      const host = hostMap.get(hostID);
      const hostName = host?.name ?? hostID;
      for (const [projectPath, sessions] of pathMap.entries()) {
        const orderedSessions = [...sessions].sort((a, b) => {
          const left = a.updatedAt ?? "";
          const right = b.updatedAt ?? "";
          if (left === right) return a.title.localeCompare(b.title);
          return left > right ? -1 : 1;
        });
        projects.push({
          hostID,
          hostName,
          path: projectPath,
          sessions: orderedSessions,
        });
      }
    }

    if (projects.length > 0) return projects;

    // Fallback: no discoverable sessions yet, still expose one default project per host.
    return sourceHosts.map((host) => ({
      hostID: host.id,
      hostName: host.name,
      path: host.workspace?.trim() || "/home/ecs-user",
      sessions: [],
    }));
  }

  function buildProjectsFromRecords(
    sourceHosts: Host[],
    projects: ProjectRecord[],
    sessions: SessionRecord[],
  ) {
    const hostMap = new Map<string, Host>();
    for (const host of sourceHosts) {
      hostMap.set(host.id, host);
    }

    const projectKeyByID = new Map<string, string>();
    const grouped = new Map<
      string,
      {
        hostID: string;
        hostName: string;
        path: string;
        sessions: Array<{ id: string; title: string; updatedAt?: string }>;
      }
    >();
    const sessionSeenByProjectKey = new Map<string, Set<string>>();

    const ensureProjectBucket = (
      hostIDRaw: string,
      hostNameRaw: string,
      pathRaw: string,
    ) => {
      const hostID = hostIDRaw.trim();
      const path = pathRaw.trim();
      if (!hostID || !path) return "";
      const key = `${hostID}::${path}`;
      if (!grouped.has(key)) {
        const host = hostMap.get(hostID);
        grouped.set(key, {
          hostID,
          hostName: hostNameRaw.trim() || host?.name || hostID,
          path,
          sessions: [],
        });
      }
      if (!sessionSeenByProjectKey.has(key)) {
        sessionSeenByProjectKey.set(key, new Set<string>());
      }
      return key;
    };

    for (const project of projects) {
      const key = ensureProjectBucket(
        project.host_id,
        project.host_name ?? "",
        project.path,
      );
      if (!key) continue;
      projectKeyByID.set(project.id, key);
    }

    for (const sessionRecord of sessions) {
      const sessionID = sessionRecord.id.trim();
      if (!sessionID) continue;
      const fromProjectID =
        projectKeyByID.get(sessionRecord.project_id.trim()) ?? "";
      const fallbackHostID = sessionRecord.host_id.trim();
      const fallbackPath = sessionRecord.path.trim();
      const fallbackHostName =
        hostMap.get(fallbackHostID)?.name ?? fallbackHostID;
      const key =
        fromProjectID ||
        ensureProjectBucket(fallbackHostID, fallbackHostName, fallbackPath);
      if (!key) continue;
      const bucket = grouped.get(key);
      const seen = sessionSeenByProjectKey.get(key);
      if (!bucket || !seen || seen.has(sessionID)) continue;
      seen.add(sessionID);
      bucket.sessions.push({
        id: sessionID,
        title: sessionRecord.title?.trim() || sessionID,
        updatedAt: sessionRecord.updated_at,
      });
    }

    for (const bucket of grouped.values()) {
      bucket.sessions.sort((a, b) => {
        const left = a.updatedAt ?? "";
        const right = b.updatedAt ?? "";
        if (left === right) return a.title.localeCompare(b.title);
        return left > right ? -1 : 1;
      });
    }

    const byHost = new Set<string>();
    for (const bucket of grouped.values()) {
      byHost.add(bucket.hostID);
    }
    for (const host of sourceHosts) {
      if (byHost.has(host.id)) continue;
      ensureProjectBucket(
        host.id,
        host.name,
        host.workspace?.trim() || "/home/ecs-user",
      );
    }

    return Array.from(grouped.values());
  }

  async function refreshProjectsFromDiscovery(
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError = true,
  ) {
    if (!discoverEnabled) {
      syncProjectsFromDiscovery(buildDiscoveredProjects(sourceHosts, []));
      return;
    }
    try {
      const discovered = await discoverCodexSessions(authToken, {
        all_hosts: true,
        fanout: Math.max(1, Math.min(8, sourceHosts.length || 1)),
        limit_per_host: 120,
      });
      syncProjectsFromDiscovery(
        buildDiscoveredProjects(sourceHosts, discovered.body.targets ?? []),
      );
    } catch {
      if (!preserveOnError) {
        syncProjectsFromDiscovery(buildDiscoveredProjects(sourceHosts, []));
      }
    }
  }

  async function refreshProjectsFromSource(
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError = true,
  ) {
    const normalizeLastStatus = (raw: string | undefined): SessionLastStatus => {
      const value = (raw ?? "").trim().toLowerCase();
      if (value === "running" || value === "pending") return "running";
      if (value === "succeeded") return "succeeded";
      if (value === "failed") return "failed";
      if (value === "canceled") return "canceled";
      return "idle";
    };
    const reconcileFromSessionRecords = (records: SessionRecord[]) => {
      const currentByID = new Map<
        string,
        { activeJobID: string; lastJobStatus: SessionLastStatus }
      >();
      for (const workspace of workspaces) {
        for (const thread of workspace.sessions) {
          currentByID.set(thread.id, {
            activeJobID: thread.activeJobID.trim(),
            lastJobStatus: thread.lastJobStatus,
          });
        }
      }

      for (const record of records) {
        const sessionID = record.id.trim();
        if (!sessionID) continue;
        const current = currentByID.get(sessionID);
        if (!current) continue;
        const nextStatus = normalizeLastStatus(record.last_status);
        const nextJobID =
          nextStatus === "running"
            ? record.last_run_id?.trim() || current.activeJobID
            : "";
        if (
          current.activeJobID === nextJobID &&
          current.lastJobStatus === nextStatus
        ) {
          continue;
        }
        setThreadJobState(sessionID, nextJobID, nextStatus);
      }
    };

    try {
      const [projects, sessions] = await Promise.all([
        listProjects(authToken, 600),
        listSessions(authToken, 1200),
      ]);
      const built = buildProjectsFromRecords(sourceHosts, projects, sessions);
      if (built.length > 0) {
        syncProjectsFromDiscovery(built);
        reconcileFromSessionRecords(sessions);
        return;
      }
    } catch {
      // fall through to discovery fallback
    }
    await refreshProjectsFromDiscovery(
      authToken,
      sourceHosts,
      discoverEnabled,
      preserveOnError,
    );
  }

  function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        window.clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function waitFor(ms: number): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function sessionPayloadRecord(
    event: SessionEventRecord,
  ): Record<string, unknown> {
    return asRecord(event.payload) ?? {};
  }

  function sessionEventRunID(event: SessionEventRecord): string {
    const direct = event.run_id?.trim() ?? "";
    if (direct) return direct;
    const payload = sessionPayloadRecord(event);
    const fromPayload =
      typeof payload.job_id === "string" ? payload.job_id.trim() : "";
    return fromPayload;
  }

  function ensureSessionRunState(
    sessionID: string,
    runID: string,
  ): SessionRunStreamState {
    const existing = sessionRunStateRef.current.get(sessionID);
    if (existing && existing.runID === runID) return existing;
    const next: SessionRunStreamState = {
      runID,
      stdout: "",
      streamSeen: false,
      assistantFinalized: false,
      failureHints: [],
    };
    sessionRunStateRef.current.set(sessionID, next);
    return next;
  }

  function markSessionDone(
    sessionID: string,
    runID: string,
    status: "succeeded" | "failed" | "canceled",
    options?: { surface?: boolean },
  ): boolean {
    if (!runID || completedJobsRef.current.has(runID)) return false;
    completedJobsRef.current.add(runID);
    if (!options?.surface) return false;
    const sessionTitle = threadTitleMapRef.current.get(sessionID) ?? "Session";
    const completion = sessionCompletionCopy(status);
    notifySessionDone(`${sessionTitle} ${completion.suffix}`, completion.body);
    pushSessionAlert({
      threadID: sessionID,
      title: `${sessionTitle} ${completion.suffix}`,
      body: completion.body,
    });
    return true;
  }

  function stopSessionStream(
    sessionID: string,
    options?: { preserveRunState?: boolean; preserveHealth?: boolean },
  ) {
    const state = sessionStreamStateRef.current.get(sessionID);
    if (!state) return;
    state.controller.abort();
    sessionStreamStateRef.current.delete(sessionID);
    if (!options?.preserveRunState) {
      sessionRunStateRef.current.delete(sessionID);
    }
    if (!options?.preserveHealth) {
      clearSessionStreamHealth(sessionID);
    }
  }

  function stopAllSessionStreams() {
    for (const state of sessionStreamStateRef.current.values()) {
      state.controller.abort();
    }
    sessionStreamStateRef.current.clear();
    sessionRunStateRef.current.clear();
    setSessionStreamHealthByID({});
  }

  async function finalizeStreamCompleted(
    sessionID: string,
    runID: string,
    completedAt?: string,
    options?: { surfaceCompletions?: boolean },
  ) {
    if (runID && completedJobsRef.current.has(runID)) {
      return;
    }
    const state = sessionRunStateRef.current.get(sessionID);
    let assistantText = state
      ? parseCodexAssistantTextFromStdout(state.stdout, false)
      : "";
    let failureSummary = state?.failureHints.join("\n") ?? "";
    let failed = failureSummary.trim() !== "";

    const authToken = tokenRef.current.trim();
    if (authToken && runID) {
      const retryDelaysMS = assistantText ? [0] : [0, 200, 350, 550, 900, 1300];
      for (let attempt = 0; attempt < retryDelaysMS.length; attempt += 1) {
        const delay = retryDelaysMS[attempt] ?? 0;
        if (delay > 0) {
          await waitFor(delay);
        }
        try {
          const job = await getRunJob(authToken, runID);
          if (!assistantText) {
            assistantText = extractAssistantTextFromJob(job);
          }
          if (jobHasTargetFailures(job)) {
            failed = true;
            if (!failureSummary) {
              failureSummary =
                summarizeTargetFailures(job) ||
                (job.error ? String(job.error) : "");
            }
          }
          const hasResponseTargets = Boolean(
            job.response &&
            "targets" in job.response &&
            Array.isArray(job.response.targets),
          );
          const terminal =
            job.status === "succeeded" ||
            job.status === "failed" ||
            job.status === "canceled";
          if (assistantText || failed || (terminal && hasResponseTargets)) {
            break;
          }
        } catch {
          if (attempt === retryDelaysMS.length - 1) {
            break;
          }
        }
      }
    }

    if (failed) {
      if (state?.streamSeen) {
        finalizeAssistantStreamEntry(sessionID, "error");
      }
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Failed",
          body: failureSummary || "Session failed.",
        },
        sessionID,
      );
      setThreadJobState(sessionID, "", "failed");
      const surfaced = markSessionDone(sessionID, runID, "failed", {
        surface:
          options?.surfaceCompletions !== false &&
          shouldSurfaceCompletion(completedAt),
      });
      if (surfaced && sessionID !== activeThreadIDRef.current) {
        setThreadUnread(sessionID, true);
      }
      sessionRunStateRef.current.delete(sessionID);
      return;
    }

    setThreadJobState(sessionID, "", "succeeded");
    if (assistantText.trim()) {
      if (state?.streamSeen && !state.assistantFinalized) {
        finalizeAssistantStreamEntry(
          sessionID,
          "success",
          clipStreamText(assistantText),
        );
      } else if (!state?.assistantFinalized) {
        addTimelineEntry(
          {
            kind: "assistant",
            state: "success",
            title: "Assistant",
            body: assistantText,
          },
          sessionID,
        );
      }
    } else if (state?.streamSeen && !state?.assistantFinalized) {
      finalizeAssistantStreamEntry(
        sessionID,
        "success",
        EMPTY_ASSISTANT_FALLBACK,
      );
    }
    const surfaced = markSessionDone(sessionID, runID, "succeeded", {
      surface:
        options?.surfaceCompletions !== false &&
        shouldSurfaceCompletion(completedAt),
    });
    if (surfaced && sessionID !== activeThreadIDRef.current) {
      setThreadUnread(sessionID, true);
    }
    sessionRunStateRef.current.delete(sessionID);
  }

  async function handleSessionEventRecord(
    sessionID: string,
    event: SessionEventRecord,
    options?: { surfaceCompletions?: boolean },
  ) {
    const payload = sessionPayloadRecord(event);
    const runID = sessionEventRunID(event);

    switch (event.type) {
      case "session.title.updated": {
        const title =
          typeof payload.title === "string" ? payload.title.trim() : "";
        if (title) {
          setThreadTitle(sessionID, title);
        }
        return;
      }
      case "run.started": {
        const id = runID || `run_${Date.now()}`;
        ensureSessionRunState(sessionID, id);
        setThreadJobState(sessionID, id, "running");
        if (sessionID === activeThreadIDRef.current) {
          setActiveJobID(id);
        }
        return;
      }
      case "assistant.delta": {
        if (!runID) return;
        const state = ensureSessionRunState(sessionID, runID);
        const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
        if (!chunk.trim()) return;
        state.stdout = `${state.stdout}${chunk}`;
        if (state.stdout.length > 220000) {
          state.stdout = state.stdout.slice(state.stdout.length - 220000);
        }
        const nextTitle = parseCodexSessionTitleFromStdout(state.stdout);
        if (nextTitle) {
          setThreadTitle(sessionID, nextTitle);
        }
        const contentOnly = parseCodexAssistantTextFromStdout(
          state.stdout,
          false,
        );
        if (contentOnly.trim()) {
          state.streamSeen = true;
          upsertAssistantStreamEntry(sessionID, clipStreamText(contentOnly));
        } else if (
          state.stdout.includes('"type":"turn.started"') ||
          state.stdout.includes('"type":"thread.started"')
        ) {
          state.streamSeen = true;
          upsertAssistantStreamEntry(sessionID, "Thinking...");
        }
        return;
      }
      case "assistant.completed": {
        if (!runID) return;
        const state = ensureSessionRunState(sessionID, runID);
        const contentOnly = parseCodexAssistantTextFromStdout(
          state.stdout,
          false,
        );
        if (contentOnly.trim()) {
          state.streamSeen = true;
          finalizeAssistantStreamEntry(
            sessionID,
            "success",
            clipStreamText(contentOnly),
          );
          state.assistantFinalized = true;
          return;
        }
        // Keep stream entry in running state when content is unavailable here.
        // run.completed/job.succeeded handler will perform job-response fallback.
        state.assistantFinalized = false;
        return;
      }
      case "target.done": {
        if (!runID) return;
        const state = ensureSessionRunState(sessionID, runID);
        const status =
          typeof payload.status === "string" ? payload.status.trim() : "";
        if (status && status !== "ok") {
          const host =
            (typeof payload.host_name === "string" &&
              payload.host_name.trim()) ||
            (typeof payload.host_id === "string" && payload.host_id.trim()) ||
            "target";
          const exitCode = payload.exit_code;
          const codeText =
            typeof exitCode === "number" ? ` exit=${exitCode}` : "";
          const errorText =
            typeof payload.error === "string" && payload.error.trim()
              ? ` error=${payload.error.trim()}`
              : "";
          state.failureHints.push(`${host} failed${codeText}${errorText}`);
        }
        return;
      }
      case "run.failed":
      case "job.failed": {
        const id = runID || `run_${Date.now()}`;
        const state = ensureSessionRunState(sessionID, id);
        const errText =
          typeof payload.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : "Session failed.";
        if (state.streamSeen) {
          finalizeAssistantStreamEntry(sessionID, "error");
        }
        addTimelineEntry(
          {
            kind: "system",
            state: "error",
            title: "Failed",
            body: errText,
          },
          sessionID,
        );
        setThreadJobState(sessionID, "", "failed");
        const surfaced = markSessionDone(sessionID, id, "failed", {
          surface:
            options?.surfaceCompletions !== false &&
            shouldSurfaceCompletion(event.created_at),
        });
        if (surfaced && sessionID !== activeThreadIDRef.current) {
          setThreadUnread(sessionID, true);
        }
        sessionRunStateRef.current.delete(sessionID);
        return;
      }
      case "run.canceled":
      case "job.canceled": {
        const id = runID || `run_${Date.now()}`;
        const state = ensureSessionRunState(sessionID, id);
        if (state.streamSeen) {
          finalizeAssistantStreamEntry(sessionID, "error");
        }
        addTimelineEntry(
          {
            kind: "system",
            state: "error",
            title: "Interrupted",
            body: "Session interrupted.",
          },
          sessionID,
        );
        setThreadJobState(sessionID, "", "canceled");
        const surfaced = markSessionDone(sessionID, id, "canceled", {
          surface:
            options?.surfaceCompletions !== false &&
            shouldSurfaceCompletion(event.created_at),
        });
        if (surfaced && sessionID !== activeThreadIDRef.current) {
          setThreadUnread(sessionID, true);
        }
        sessionRunStateRef.current.delete(sessionID);
        return;
      }
      case "run.completed":
      case "job.succeeded": {
        if (!runID) return;
        await finalizeStreamCompleted(sessionID, runID, event.created_at, {
          surfaceCompletions: options?.surfaceCompletions !== false,
        });
        return;
      }
      default:
        return;
    }
  }

  function decodeSessionEventRecord(input: unknown): SessionEventRecord | null {
    const payload = asRecord(input);
    if (!payload) return null;
    const seq =
      typeof payload.seq === "number" ? payload.seq : Number(payload.seq);
    if (!Number.isFinite(seq) || seq <= 0) return null;
    const sessionID =
      typeof payload.session_id === "string" ? payload.session_id.trim() : "";
    const eventType =
      typeof payload.type === "string" ? payload.type.trim() : "";
    if (!sessionID || !eventType) return null;
    const createdAt =
      typeof payload.created_at === "string" && payload.created_at.trim()
        ? payload.created_at
        : new Date().toISOString();
    const runID =
      typeof payload.run_id === "string" ? payload.run_id : undefined;
    return {
      seq,
      session_id: sessionID,
      run_id: runID,
      type: eventType,
      payload: payload.payload,
      created_at: createdAt,
    };
  }

  function handleSessionStreamFrame(
    sessionID: string,
    frame: SessionStreamFrame,
  ) {
    const state = sessionStreamStateRef.current.get(sessionID);
    if (!state) return;
    const receivedAt = Date.now();
    state.lastEventAt = receivedAt;

    if (frame.event === "session.ready") {
      state.ready = true;
      updateSessionStreamHealth(sessionID, "live", {
        lastEventAt: receivedAt,
        lastError: "",
      });
      const data = asRecord(frame.data);
      const cursor = data ? Number(data.cursor) : NaN;
      if (
        Number.isFinite(cursor) &&
        cursor > (sessionEventCursorRef.current.get(sessionID) ?? 0)
      ) {
        sessionEventCursorRef.current.set(sessionID, cursor);
      }
      return;
    }

    if (frame.event === "session.reset") {
      state.ready = false;
      updateSessionStreamHealth(sessionID, "reconnecting", {
        lastEventAt: receivedAt,
        throttleMS: 0,
      });
      const data = asRecord(frame.data);
      const nextAfter = data ? Number(data.next_after) : NaN;
      if (
        Number.isFinite(nextAfter) &&
        nextAfter > (sessionEventCursorRef.current.get(sessionID) ?? 0)
      ) {
        sessionEventCursorRef.current.set(sessionID, nextAfter);
      }
      return;
    }

    if (frame.event === "heartbeat") {
      updateSessionStreamHealth(sessionID, "live", {
        lastEventAt: receivedAt,
      });
      return;
    }

    if (frame.event !== "session.event") {
      return;
    }

    const surfaceCompletions = state.ready;
    updateSessionStreamHealth(sessionID, "live", {
      lastEventAt: receivedAt,
      lastError: "",
    });
    const event = decodeSessionEventRecord(frame.data);
    if (!event) return;
    const current = sessionEventCursorRef.current.get(sessionID) ?? 0;
    if (event.seq <= current) return;
    sessionEventCursorRef.current.set(sessionID, event.seq);
    void handleSessionEventRecord(sessionID, event, {
      surfaceCompletions,
    });
  }

  function startSessionStream(sessionID: string, authToken: string) {
    const trimmedSessionID = sessionID.trim();
    if (!trimmedSessionID) return;
    if (sessionStreamStateRef.current.has(trimmedSessionID)) return;

    const controller = new AbortController();
    sessionStreamStateRef.current.set(trimmedSessionID, {
      controller,
      ready: false,
      lastEventAt: 0,
    });
    updateSessionStreamHealth(trimmedSessionID, "connecting", {
      retries: 0,
      lastEventAt: 0,
      lastError: "",
      throttleMS: 0,
    });

    const run = async () => {
      let backoff = 700;
      let retries = 0;
      while (!controller.signal.aborted) {
        if (retries > 0) {
          updateSessionStreamHealth(trimmedSessionID, "reconnecting", {
            retries,
            throttleMS: 0,
          });
        }
        const after = sessionEventCursorRef.current.get(trimmedSessionID) ?? 0;
        try {
          await streamSessionEvents(authToken, trimmedSessionID, {
            after,
            signal: controller.signal,
            onFrame: (frame) =>
              handleSessionStreamFrame(trimmedSessionID, frame),
          });
          if (controller.signal.aborted) break;
          const isRunning = runningSessionIDsRef.current.has(trimmedSessionID);
          if (isRunning) {
            retries += 1;
            updateSessionStreamHealth(trimmedSessionID, "reconnecting", {
              retries,
              lastError: "stream closed, retrying",
              throttleMS: 0,
            });
          } else {
            retries = 0;
            updateSessionStreamHealth(trimmedSessionID, "live", {
              retries: 0,
              lastError: "",
              throttleMS: 0,
            });
          }
        } catch {
          if (controller.signal.aborted) break;
          retries += 1;
          updateSessionStreamHealth(
            trimmedSessionID,
            retries >= 3 ? "error" : "reconnecting",
            {
              retries,
              lastError: "stream interrupted, retrying",
              throttleMS: 0,
            },
          );
        }
        const active = sessionStreamStateRef.current.get(trimmedSessionID);
        if (
          !active ||
          active.controller !== controller ||
          controller.signal.aborted
        )
          break;
        active.ready = false;
        await waitWithAbort(backoff, controller.signal);
        backoff = Math.min(6000, Math.round(backoff * 1.7));
      }
      const active = sessionStreamStateRef.current.get(trimmedSessionID);
      if (active && active.controller === controller) {
        sessionStreamStateRef.current.delete(trimmedSessionID);
        updateSessionStreamHealth(trimmedSessionID, "offline", {
          throttleMS: 0,
        });
      }
    };
    void run();
  }

  async function loadWorkspace(authToken: string, emitConnectedNote: boolean) {
    const refreshStartedAtMS = Date.now();
    setIsRefreshing(true);
    try {
      const [
        healthBody,
        fetchedHosts,
        nextRuntimes,
        nextJobs,
        nextRuns,
        nextAudit,
        nextMetrics,
      ] = await Promise.all([
        healthz(),
        listHosts(authToken),
        listRuntimes(authToken),
        listRunJobs(authToken, 20),
        listRuns(authToken, 20),
        listAudit(authToken, 80),
        getMetrics(authToken),
      ]);
      const nextHosts = await ensureLocalCodexHost(authToken, fetchedHosts);

      setHealth(`ok ${healthBody.timestamp}`);
      setHosts(nextHosts);
      setRuntimes(nextRuntimes);
      setJobs(nextJobs);
      setRuns(nextRuns);
      setAuditEvents(nextAudit);
      setMetrics(nextMetrics);

      const localHost = nextHosts.find(
        (host) => host.connection_mode === "local",
      );
      if (localHost) {
        setAllHosts(false);
        setSelectedHostIDs([localHost.id]);
      } else {
        setSelectedHostIDs((prev) => {
          const nextSelected = prev.filter((id) =>
            nextHosts.some((host) => host.id === id),
          );
          if (nextSelected.length > 0) return nextSelected;
          if (nextHosts.length > 0) return [nextHosts[0].id];
          return [];
        });
      }
      const codexRuntime = nextRuntimes.find(
        (runtime) => runtime.name === "codex",
      );
      if (codexRuntime) {
        setSelectedRuntime("codex");
      } else if (
        !nextRuntimes.some((runtime) => runtime.name === selectedRuntime)
      ) {
        setSelectedRuntime(nextRuntimes[0]?.name ?? "codex");
      }
      await refreshProjectsFromSource(
        authToken,
        nextHosts,
        nextRuntimes.some((runtime) => runtime.name === "codex"),
        workspaces.length > 0,
      );

      const running = nextJobs.find((job) => isJobActive(job));
      if (running) {
        setActiveJobID(running.id);
        setActiveJob(running);
      } else {
        setActiveJobID("");
        setActiveJob(null);
      }
      for (const job of nextJobs) {
        if (!isJobActive(job)) continue;
        if (!jobEventCursorRef.current.has(job.id)) {
          jobEventCursorRef.current.set(job.id, 0);
        }
        if (!jobStreamSeenRef.current.has(job.id)) {
          jobStreamSeenRef.current.set(job.id, false);
        }
      }

      if (emitConnectedNote) {
        addTimelineEntry(
          {
            kind: "system",
            state: "success",
            title: "Connected",
            body: `Connected. hosts=${nextHosts.length} runtimes=${nextRuntimes.length} queue_depth=${nextMetrics.queue.depth}`,
          },
          activeThreadID,
        );
      }
      // Only surface completion alerts for events that happen after this sync starts.
      completionAlertCutoffMSRef.current = refreshStartedAtMS;
    } catch (error) {
      setHealth(`error: ${String(error)}`);
      if (emitConnectedNote) {
        addTimelineEntry(
          {
            kind: "system",
            state: "error",
            title: "Connection Failed",
            body: String(error),
          },
          activeThreadID,
        );
      }
      throw error;
    } finally {
      setIsRefreshing(false);
    }
  }

  async function unlockWorkspace(candidateToken: string) {
    const trimmed = candidateToken.trim();
    if (!trimmed) {
      setAuthError("token is required");
      setAuthPhase("locked");
      return;
    }

    setAuthPhase("checking");
    setAuthError("");

    try {
      await Promise.all([listRuntimes(trimmed), listHosts(trimmed)]);
      localStorage.setItem(TOKEN_KEY, trimmed);
      setToken(trimmed);
      setTokenInput(trimmed);
      await loadWorkspace(trimmed, true);
      setAuthPhase("ready");
    } catch (error) {
      localStorage.removeItem(TOKEN_KEY);
      setToken("");
      setAuthPhase("locked");
      setAuthError(`token validation failed: ${String(error)}`);
    }
  }

  useEffect(() => {
    const cached = localStorage.getItem(TOKEN_KEY) ?? "";
    if (!cached.trim()) {
      setAuthPhase("locked");
      return;
    }
    void unlockWorkspace(cached);
  }, []);

  useEffect(() => {
    const ready = authPhase === "ready" && token.trim() !== "";
    if (!ready) {
      streamAuthTokenRef.current = "";
      stopAllSessionStreams();
      return;
    }
    if (streamAuthTokenRef.current !== token) {
      stopAllSessionStreams();
      streamAuthTokenRef.current = token;
    }

    const expected = new Set(sessionStreamTargetIDs);
    for (const sessionID of expected) {
      if (!sessionStreamStateRef.current.has(sessionID)) {
        startSessionStream(sessionID, token);
      }
    }
    for (const sessionID of Array.from(sessionStreamStateRef.current.keys())) {
      if (expected.has(sessionID)) continue;
      stopSessionStream(sessionID);
    }
  }, [authPhase, token, sessionStreamTargetIDs]);

  useEffect(() => {
    return () => {
      stopAllSessionStreams();
    };
  }, []);

  useEffect(() => {
    if (authPhase !== "ready" || !token.trim()) return;
    if (!activeSessionHostID) return;
    if (!runtimes.some((runtime) => runtime.name === "codex")) return;
    let canceled = false;
    void discoverCodexModels(token, { host_id: activeSessionHostID })
      .then((catalog) => {
        if (canceled) return;
        const nextDefault = catalog.default_model?.trim() || "";
        const nextModels = Array.isArray(catalog.models)
          ? catalog.models.filter((name) => name.trim() !== "")
          : [];
        setSessionModelDefault(nextDefault);
        setSessionModelOptions(nextModels);
      })
      .catch(() => {
        if (canceled) return;
        setSessionModelDefault("");
        setSessionModelOptions([]);
      });
    return () => {
      canceled = true;
    };
  }, [authPhase, token, activeSessionHostID, runtimes]);

  useEffect(() => {
    if (authPhase !== "ready" || !token.trim()) return;
    if (appMode !== "session") return;
    if (!runtimes.some((runtime) => runtime.name === "codex")) return;
    if (hosts.length === 0) return;
    if (runningThreadJobs.length > 0 || submittingThreadID !== "") return;

    let canceled = false;
    const refresh = async () => {
      try {
        await refreshProjectsFromSource(token, hosts, true, true);
      } catch {
        // no-op: best-effort title/session sync
      }
    };

    const timer = window.setInterval(() => {
      if (canceled) return;
      void refresh();
    }, 25000);

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [
    authPhase,
    token,
    appMode,
    hosts,
    runtimes,
    runningThreadJobs.length,
    submittingThreadID,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncFromHash = () => {
      setAppMode(modeFromHash(window.location.hash));
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
    };
  }, []);

  useEffect(() => {
    const node = timelineViewportRef.current;
    if (!node) return;
    const threadChanged = lastTimelineThreadIDRef.current !== activeThreadID;
    if (threadChanged) {
      lastTimelineThreadIDRef.current = activeThreadID;
      timelineForceStickRef.current = true;
    }
    const shouldStick =
      timelineForceStickRef.current ||
      timelineStickToBottomRef.current ||
      threadChanged;
    if (!shouldStick) return;
    const frame = window.requestAnimationFrame(() => {
      if (timelineBottomRef.current) {
        timelineBottomRef.current.scrollIntoView({ block: "end" });
      } else {
        node.scrollTop = node.scrollHeight;
      }
      timelineForceStickRef.current = false;
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    activeThreadID,
    activeTimeline.length,
    activeTimelineTail?.body,
    activeTimelineTail?.state,
  ]);

  function onTimelineScroll() {
    const node = timelineViewportRef.current;
    if (!node) return;
    const gap = Math.abs(
      node.scrollHeight - node.clientHeight - node.scrollTop,
    );
    timelineStickToBottomRef.current = gap <= 72;
  }

  useEffect(() => {
    const node = promptInputRef.current;
    if (!node) return;
    node.style.height = "0px";
    const nextHeight = Math.max(92, Math.min(240, node.scrollHeight));
    node.style.height = `${nextHeight}px`;
  }, [activeThreadID, activeDraft]);

  useEffect(() => {
    if (appMode !== "session" || authPhase !== "ready" || !token.trim()) return;
    if (!activeThread?.activeJobID) {
      setActiveJobID("");
      setActiveJob(null);
      return;
    }
    void getRunJob(token, activeThread.activeJobID)
      .then((job) => {
        setActiveJobID(job.id);
        setActiveJob(job);
      })
      .catch(() => {
        setActiveJobID("");
        setActiveJob(null);
      });
  }, [appMode, authPhase, token, activeThread?.id, activeThread?.activeJobID]);

  useEffect(() => {
    if (authPhase !== "ready") return;

    const handleGlobalKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        promptInputRef.current?.focus();
        return;
      }

      if (appMode !== "session") return;

      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        createThreadAndFocus();
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        (event.key === "ArrowUp" || event.key === "[")
      ) {
        event.preventDefault();
        switchThreadByOffset(-1);
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        (event.key === "ArrowDown" || event.key === "]")
      ) {
        event.preventDefault();
        switchThreadByOffset(1);
      }
    };

    window.addEventListener("keydown", handleGlobalKeydown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeydown);
    };
  }, [authPhase, appMode, threads, activeThreadID]);

  useEffect(() => {
    if (authPhase !== "ready" || !token.trim()) return;
    if (runningThreadJobs.length === 0) return;

    let canceled = false;
    const poll = async () => {
      const pollingJobs = runningThreadJobs;
      if (pollingJobs.length === 0) return;
      try {
        const jobResults = await Promise.all(
          pollingJobs.map(async (item) => {
            try {
              const after = jobEventCursorRef.current.get(item.jobID) ?? 0;
              const [job, eventFeed] = await Promise.all([
                getRunJob(token, item.jobID),
                listRunJobEvents(token, item.jobID, after, 240).catch(() => ({
                  events: [] as RunJobEvent[],
                  next_after: after,
                })),
              ]);
              return {
                item,
                job,
                error: "",
                events: eventFeed.events,
                nextAfter: eventFeed.next_after,
              };
            } catch (error) {
              return {
                item,
                job: null as RunJobRecord | null,
                error: String(error),
                events: [] as RunJobEvent[],
                nextAfter: jobEventCursorRef.current.get(item.jobID) ?? 0,
              };
            }
          }),
        );
        if (canceled) return;

        let needsProjectRefresh = false;
        for (const result of jobResults) {
          const { item, job, error, events, nextAfter } = result;
          if (!job) {
            addTimelineEntry(
              {
                kind: "system",
                state: "error",
                title: "Session Sync Failed",
                body: error,
              },
              item.threadID,
            );
            setThreadJobState(item.threadID, "", "failed");
            continue;
          }
          jobEventCursorRef.current.set(item.jobID, nextAfter);
          const alreadyCompleted = completedJobsRef.current.has(item.jobID);

          let stdoutStream = "";
          const terminalHints: string[] = [];
          const showLiveStream =
            appMode === "session" && item.threadID === activeThreadID;
          for (const event of events) {
            if (
              event.type === "target.stdout" &&
              typeof event.chunk === "string"
            ) {
              stdoutStream += event.chunk;
            }
            if (
              event.type === "target.done" &&
              event.status &&
              event.status !== "ok"
            ) {
              const line = summarizeJobEventLine(event);
              if (line) terminalHints.push(line);
            }
            if (
              event.type === "job.failed" ||
              event.type === "job.canceled" ||
              event.type === "job.cancel_requested"
            ) {
              const line = summarizeJobEventLine(event);
              if (line) terminalHints.push(line);
            }
          }
          if (!alreadyCompleted && showLiveStream && stdoutStream.trim()) {
            if (job.runtime === "codex") {
              const nextTitle = parseCodexSessionTitleFromStdout(stdoutStream);
              if (nextTitle) {
                setThreadTitle(item.threadID, nextTitle);
              }
              const contentOnly = parseCodexAssistantTextFromStdout(
                stdoutStream,
                false,
              );
              if (contentOnly.trim()) {
                jobStreamSeenRef.current.set(item.jobID, true);
                upsertAssistantStreamEntry(
                  item.threadID,
                  clipStreamText(contentOnly),
                );
              } else if (
                stdoutStream.includes('"type":"turn.started"') ||
                stdoutStream.includes('"type":"thread.started"')
              ) {
                jobStreamSeenRef.current.set(item.jobID, true);
                upsertAssistantStreamEntry(item.threadID, "Thinking...");
              }
            } else {
              jobStreamSeenRef.current.set(item.jobID, true);
              upsertAssistantStreamEntry(
                item.threadID,
                clipStreamText(stdoutStream),
              );
            }
          }
          if (terminalHints.length > 0) {
            addTimelineEntry(
              {
                kind: "system",
                state: "error",
                title: "Failed",
                body: terminalHints.join("\n"),
              },
              item.threadID,
            );
          }

          if (item.threadID === activeThreadID) {
            setActiveJob(job);
            setActiveJobID(job.id);
          }

          if (isJobActive(job)) {
            setThreadJobState(item.threadID, job.id, "running");
            continue;
          }

          const responseFailed = jobHasTargetFailures(job);
          const assistantText =
            job.status === "succeeded" ? extractAssistantTextFromJob(job) : "";
          if (
            job.runtime === "codex" &&
            job.status === "succeeded" &&
            !responseFailed &&
            !assistantText.trim()
          ) {
            const retries =
              jobNoTextFinalizeRetriesRef.current.get(job.id) ?? 0;
            if (retries < 4) {
              jobNoTextFinalizeRetriesRef.current.set(job.id, retries + 1);
              setThreadJobState(item.threadID, job.id, "running");
              continue;
            }
          } else {
            jobNoTextFinalizeRetriesRef.current.delete(job.id);
          }

          if (job.runtime === "codex") {
            needsProjectRefresh = true;
          }
          const terminalStatus =
            job.status === "failed" || job.status === "canceled"
              ? job.status
              : responseFailed
                ? "failed"
                : job.status === "succeeded"
                  ? "succeeded"
                  : "failed";
          const shouldSurfaceJobCompletion = shouldSurfaceCompletion(
            job.finished_at || job.started_at || job.queued_at,
          );
          setThreadJobState(item.threadID, "", terminalStatus);
          jobEventCursorRef.current.delete(item.jobID);
          jobNoTextFinalizeRetriesRef.current.delete(job.id);
          const sawStream = Boolean(jobStreamSeenRef.current.get(item.jobID));
          jobStreamSeenRef.current.delete(item.jobID);
          if (shouldSurfaceJobCompletion && item.threadID !== activeThreadID) {
            setThreadUnread(item.threadID, true);
          }

          if (completedJobsRef.current.has(job.id)) {
            if (job.status === "succeeded") {
              if (assistantText) {
                if (sawStream) {
                  finalizeAssistantStreamEntry(
                    item.threadID,
                    "success",
                    assistantText,
                  );
                }
              } else if (sawStream) {
                finalizeAssistantStreamEntry(
                  item.threadID,
                  "success",
                  EMPTY_ASSISTANT_FALLBACK,
                );
              }
            }
            continue;
          }

          completedJobsRef.current.add(job.id);
          {
            const failedSummary = summarizeTargetFailures(job);
            if (
              job.status === "failed" ||
              job.status === "canceled" ||
              responseFailed
            ) {
              if (sawStream) {
                finalizeAssistantStreamEntry(item.threadID, "error");
              }
              addTimelineEntry(
                {
                  kind: "system",
                  state: "error",
                  title: job.status === "canceled" ? "Interrupted" : "Failed",
                  body:
                    failedSummary ||
                    (job.status === "canceled"
                      ? "Session interrupted."
                      : job.error
                        ? String(job.error)
                        : "Session failed."),
                },
                item.threadID,
              );
            } else if (assistantText) {
              if (sawStream) {
                finalizeAssistantStreamEntry(
                  item.threadID,
                  "success",
                  assistantText,
                );
              } else {
                addTimelineEntry(
                  {
                    kind: "assistant",
                    state: "success",
                    title: "Assistant",
                    body: assistantText,
                  },
                  item.threadID,
                );
              }
            } else if (sawStream) {
              finalizeAssistantStreamEntry(
                item.threadID,
                "success",
                EMPTY_ASSISTANT_FALLBACK,
              );
            }
            const sessionTitle =
              threadTitleMapRef.current.get(item.threadID) ?? "Session";
            const completionStatus: "succeeded" | "failed" | "canceled" =
              job.status === "canceled"
                ? "canceled"
                : job.status === "succeeded" && !responseFailed
                  ? "succeeded"
                  : "failed";
            const completion = sessionCompletionCopy(completionStatus);
            if (shouldSurfaceJobCompletion) {
              notifySessionDone(
                `${sessionTitle} ${completion.suffix}`,
                completion.body,
              );
              pushSessionAlert({
                threadID: item.threadID,
                title: `${sessionTitle} ${completion.suffix}`,
                body: completion.body,
              });
            }
          }
        }

        const [nextJobs, nextRuns, nextAudit, refreshedMetrics] =
          await Promise.all([
            listRunJobs(token, 20),
            listRuns(token, 20),
            listAudit(token, 80),
            getMetrics(token),
          ]);
        if (canceled) return;
        setJobs(nextJobs);
        setRuns(nextRuns);
        setAuditEvents(nextAudit);
        setMetrics(refreshedMetrics);
        if (needsProjectRefresh) {
          await refreshProjectsFromSource(
            token,
            hosts,
            runtimes.some((runtime) => runtime.name === "codex"),
            true,
          );
          if (canceled) return;
        }
      } catch {
        if (canceled) return;
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2100);

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [
    authPhase,
    token,
    appMode,
    runningThreadJobs,
    activeThreadID,
    hosts,
    runtimes,
  ]);

  useEffect(() => {
    if (authPhase !== "ready" || !token.trim() || appMode !== "ops") return;

    let canceled = false;
    const timer = window.setInterval(async () => {
      try {
        const [nextJobs, nextRuns, nextAudit, nextMetrics] = await Promise.all([
          listRunJobs(token, 20),
          listRuns(token, 20),
          listAudit(token, 80),
          getMetrics(token),
        ]);
        if (canceled) return;
        setJobs(nextJobs);
        setRuns(nextRuns);
        setAuditEvents(nextAudit);
        setMetrics(nextMetrics);

        if (!activeJobID) {
          const running = nextJobs.find((job) => isJobActive(job));
          if (running) {
            setActiveJobID(running.id);
            setActiveJob(running);
          }
        }
      } catch {
        if (canceled) return;
      }
    }, 5000);

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [authPhase, token, appMode, activeJobID]);

  async function onSubmitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await unlockWorkspace(tokenInput);
  }

  function switchMode(nextMode: AppMode) {
    setAppMode(nextMode);
    if (typeof window !== "undefined") {
      const nextHash = modeToHash(nextMode);
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, "", nextHash);
      }
    }
  }

  function onLogout() {
    localStorage.removeItem(TOKEN_KEY);
    stopAllSessionStreams();
    streamAuthTokenRef.current = "";
    resetOpsDomain();
    resetSessionDomain();
    jobEventCursorRef.current.clear();
    jobStreamSeenRef.current.clear();
    jobNoTextFinalizeRetriesRef.current.clear();
    sessionEventCursorRef.current.clear();
    sessionRunStateRef.current.clear();
    setSubmittingThreadID("");
    setSessionAlerts([]);
    setSessionModelDefault("");
    setSessionModelOptions([]);
    setToken("");
    setTokenInput("");
    setAuthError("");
    setAuthPhase("locked");
    switchMode("session");
  }

  function toggleHostSelection(hostID: string) {
    setSelectedHostIDs((prev) => {
      if (prev.includes(hostID)) return prev.filter((id) => id !== hostID);
      return [...prev, hostID];
    });
  }

  async function onRefreshWorkspace() {
    if (authPhase !== "ready" || !token.trim()) return;
    await loadWorkspace(token, false);
  }

  async function onArchiveActiveSession() {
    if (authPhase !== "ready" || !token.trim() || !activeThread) return;
    const targetSessionID = activeThread.id.trim();
    if (!targetSessionID) return;
    if (activeThread.activeJobID || submittingThreadID === targetSessionID) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Archive Blocked",
          body: "Session is running. Stop it before archiving.",
        },
        targetSessionID,
      );
      return;
    }
    const confirmed = window.confirm(
      `Archive session "${activeThread.title}" on host "${activeWorkspace?.hostName || "unknown"}"?`,
    );
    if (!confirmed) return;

    setDeletingThreadID(targetSessionID);
    try {
      await archiveSession(token, targetSessionID);
      stopSessionStream(targetSessionID);
      sessionEventCursorRef.current.delete(targetSessionID);
      sessionRunStateRef.current.delete(targetSessionID);
      removeThread(targetSessionID);
      await refreshProjectsFromSource(token, hosts, false, true);
    } catch (error) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Archive Failed",
          body: String(error),
        },
        targetSessionID,
      );
    } finally {
      setDeletingThreadID("");
    }
  }

  function onReconnectActiveStream() {
    if (authPhase !== "ready" || !token.trim()) return;
    const sessionID = activeThreadID.trim();
    if (!sessionID) return;
    stopSessionStream(sessionID, { preserveRunState: true, preserveHealth: true });
    updateSessionStreamHealth(sessionID, "connecting", {
      throttleMS: 0,
      lastError: "",
    });
    startSessionStream(sessionID, token);
  }

  async function onSendPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authPhase !== "ready" || !token.trim() || !activeThread) return;
    if (activeThread.activeJobID || submittingThreadID === activeThread.id) {
      addTimelineEntry(
        {
          kind: "system",
          state: "running",
          title: "Session Busy",
          body: "This session is already running. Wait for completion or switch to another session.",
        },
        activeThread.id,
      );
      return;
    }

    const editorValue = promptInputRef.current?.value ?? "";
    const trimmedPrompt = activeThread.draft.trim() || editorValue.trim();
    if (!trimmedPrompt) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Prompt Missing",
          body: "Prompt is required.",
        },
        activeThread.id,
      );
      return;
    }
    if (isGenericSessionTitle(activeThread.title)) {
      const nextTitle = deriveSessionTitleFromPrompt(trimmedPrompt);
      if (nextTitle) {
        setThreadTitle(activeThread.id, nextTitle);
      }
    }

    const workspaceHostID = activeWorkspace?.hostID?.trim() ?? "";
    const localHostIDs = hosts
      .filter((host) => host.connection_mode === "local")
      .map((host) => host.id);
    const targetHostIDs =
      workspaceHostID !== ""
        ? [workspaceHostID]
        : selectedHostIDs.length > 0
          ? selectedHostIDs
          : localHostIDs.length > 0
            ? localHostIDs
            : hosts.length > 0
              ? [hosts[0].id]
              : [];
    if (targetHostIDs.length === 0) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "No Target Host",
          body: "No target server available for this session.",
        },
        activeThread.id,
      );
      return;
    }

    const selectedHosts = hosts.filter((host) =>
      targetHostIDs.includes(host.id),
    );
    const hasNonLocalTarget = selectedHosts.some(
      (host) => host.connection_mode !== "local",
    );
    const safeImagePaths = hasNonLocalTarget ? [] : activeThread.imagePaths;
    if (hasNonLocalTarget && activeThread.imagePaths.length > 0) {
      addTimelineEntry(
        {
          kind: "system",
          state: "running",
          title: "Image Attachment Skipped",
          body: "Image attachments are only applied to local-mode targets.",
        },
        activeThread.id,
      );
    }

    const fanout = Math.max(1, Number.parseInt(fanoutValue, 10) || 1);
    const outputCap = Math.max(32, Number.parseInt(maxOutputKB, 10) || 256);
    const effectiveModel =
      activeThread.model.trim() ||
      sessionModelDefault.trim() ||
      sessionModelChoices[0]?.trim() ||
      undefined;
    const effectiveSandbox =
      activeThread.sandbox || runSandbox || "workspace-write";
    const effectiveWorkdir = activeWorkspace?.path.trim() || undefined;

    const request: RunRequest = {
      runtime: activeRuntime?.name ?? selectedRuntime,
      prompt: trimmedPrompt,
      session_id: activeThread.id,
      all_hosts: false,
      host_ids: targetHostIDs,
      workdir: effectiveWorkdir,
      fanout,
      max_output_kb: outputCap,
      codex:
        (activeRuntime?.name ?? selectedRuntime) === "codex"
          ? {
              mode: "exec",
              model: effectiveModel,
              sandbox: effectiveSandbox,
              images: safeImagePaths.length > 0 ? safeImagePaths : undefined,
              json_output: true,
              skip_git_repo_check: true,
              ephemeral: false,
            }
          : undefined,
    };

    addTimelineEntry(
      {
        kind: "user",
        title: "You",
        body: trimmedPrompt,
      },
      activeThread.id,
    );
    if (runAsyncMode) {
      upsertAssistantStreamEntry(activeThread.id, "Thinking...");
    }
    timelineForceStickRef.current = true;
    timelineStickToBottomRef.current = true;
    updateThreadDraft(activeThread.id, "");

    setSubmittingThreadID(activeThread.id);
    try {
      if (runAsyncMode) {
        const { body } = await enqueueRunJob(token, request);
        jobEventCursorRef.current.set(body.job.id, 0);
        jobStreamSeenRef.current.set(body.job.id, false);
        ensureSessionRunState(activeThread.id, body.job.id);
        setActiveJobID(body.job.id);
        setActiveJobThreadID(activeThread.id);
        setActiveJob(body.job);
        setThreadJobState(activeThread.id, body.job.id, "running");
        setJobs((prev) => [
          body.job,
          ...prev.filter((job) => job.id !== body.job.id),
        ]);
        setSubmittingThreadID("");
      } else {
        const { status, body } = await runFanout(token, request);
        addTimelineEntry(
          {
            kind: "assistant",
            state: status >= 400 ? "error" : "success",
            title: `Run Finished (HTTP ${status})`,
            body: summarizeRunResponse(body),
          },
          activeThread.id,
        );

        const [nextRuns, nextJobs, nextAudit, nextMetrics] = await Promise.all([
          listRuns(token, 20),
          listRunJobs(token, 20),
          listAudit(token, 80),
          getMetrics(token),
        ]);
        setRuns(nextRuns);
        setJobs(nextJobs);
        setAuditEvents(nextAudit);
        setMetrics(nextMetrics);
        setThreadJobState(
          activeThread.id,
          "",
          status >= 400 ? "failed" : "succeeded",
        );
        setSubmittingThreadID("");
      }
    } catch (error) {
      finalizeAssistantStreamEntry(activeThread.id, "error");
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Run Failed",
          body: String(error),
        },
        activeThread.id,
      );
      setThreadJobState(activeThread.id, "", "failed");
      setSubmittingThreadID("");
    }
  }

  async function onAddHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authPhase !== "ready" || !token.trim()) return;

    const mode = hostForm.connectionMode ?? "ssh";
    if (!hostForm.name.trim() || (mode === "ssh" && !hostForm.host.trim())) {
      const validationMessage =
        mode === "ssh"
          ? "name and host are required for ssh mode."
          : "name is required.";
      addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Host Validation",
        body: validationMessage,
      });
      return;
    }

    const hostName = hostForm.name.trim();
    const editing = editingHostID;

    setAddingHost(true);
    try {
      await upsertHost(token, {
        id: editing || undefined,
        name: hostName,
        connection_mode: mode,
        host: hostForm.host.trim() || undefined,
        user: hostForm.user.trim() || undefined,
        workspace: hostForm.workspace.trim() || undefined,
      });
      setHostForm({
        name: "",
        connectionMode: "ssh",
        host: "",
        user: "",
        workspace: "",
      });
      setEditingHostID("");
      await loadWorkspace(token, false);
      addTimelineEntry({
        kind: "system",
        state: "success",
        title: editing ? "Host Updated" : "Host Saved",
        body: `${editing ? "Updated" : "Saved"} host ${hostName}.`,
      });
      setOpsNotice(`${editing ? "Updated" : "Saved"} host ${hostName}.`);
    } catch (error) {
      addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Host Save Failed",
        body: String(error),
      });
    } finally {
      setAddingHost(false);
    }
  }

  function onStartEditHost(host: Host) {
    setEditingHostID(host.id);
    setHostForm({
      name: host.name,
      connectionMode: host.connection_mode === "local" ? "local" : "ssh",
      host: host.host,
      user: host.user ?? "",
      workspace: host.workspace ?? "",
    });
    setOpsNotice(`Editing host ${host.name}.`);
  }

  function onCancelHostEdit() {
    setEditingHostID("");
    setHostForm({
      name: "",
      connectionMode: "ssh",
      host: "",
      user: "",
      workspace: "",
    });
    setOpsNotice("Canceled host edit.");
  }

  async function onProbeHost(host: Host) {
    if (authPhase !== "ready" || !token.trim()) return;
    setOpsHostBusyID(host.id);
    setOpsNotice(`Probing ${host.name}...`);
    try {
      const result = await probeHost(token, host.id, { preflight: true });
      const ssh = result.ssh?.ok ? "ok" : "fail";
      const codex = result.codex?.ok ? "ok" : "fail";
      const login = result.codex_login?.ok ? "ok" : "fail";
      const sshErr = result.ssh?.error ? ` ssh_error=${result.ssh.error}` : "";
      const codexErr = result.codex?.error
        ? ` codex_error=${result.codex.error}`
        : "";
      const loginErr = result.codex_login?.error
        ? ` login_error=${result.codex_login.error}`
        : "";
      setOpsNotice(
        `Probe ${host.name}: ssh=${ssh} codex=${codex} login=${login}${sshErr}${codexErr}${loginErr}`,
      );
    } catch (error) {
      setOpsNotice(`Probe failed for ${host.name}: ${String(error)}`);
    } finally {
      setOpsHostBusyID("");
    }
  }

  async function onDeleteHost(host: Host) {
    if (authPhase !== "ready" || !token.trim()) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Delete host '${host.name}'?`);
      if (!confirmed) return;
    }

    setOpsHostBusyID(host.id);
    try {
      await deleteHost(token, host.id);
      setSelectedHostIDs((prev) => prev.filter((id) => id !== host.id));
      if (editingHostID === host.id) {
        onCancelHostEdit();
      }
      await loadWorkspace(token, false);
      setOpsNotice(`Deleted host ${host.name}.`);
    } catch (error) {
      setOpsNotice(`Delete failed for ${host.name}: ${String(error)}`);
    } finally {
      setOpsHostBusyID("");
    }
  }

  async function onCancelJob(job: RunJobRecord) {
    if (authPhase !== "ready" || !token.trim()) return;
    if (!isJobActive(job)) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Cancel job '${job.id}'?`);
      if (!confirmed) return;
    }
    try {
      await cancelRunJob(token, job.id);
      const related = runningThreadJobs.find((item) => item.jobID === job.id);
      if (related) {
        setThreadJobState(related.threadID, "", "canceled");
      }
      setOpsNotice(`Cancel requested for ${job.id}.`);
      await loadWorkspace(token, false);
    } catch (error) {
      setOpsNotice(`Cancel failed for ${job.id}: ${String(error)}`);
    }
  }

  async function onUploadSessionImage(file: File) {
    if (authPhase !== "ready" || !token.trim() || !activeThread) return;
    setUploadingImage(true);
    setImageUploadError("");
    try {
      const uploaded = await uploadImage(token, file);
      addThreadImagePath(activeThread.id, uploaded.path);
    } catch (error) {
      setImageUploadError(String(error));
    } finally {
      setUploadingImage(false);
    }
  }

  if (authPhase !== "ready") {
    return (
      <div className="gate-shell">
        <div className="gate-noise" />
        <section className="gate-card">
          <p className="gate-eyebrow">remote-llm workspace</p>
          <h1>Token Required</h1>
          <p className="gate-copy">
            Use your access token to unlock the operator console. No token means
            no workspace access.
          </p>
          <form onSubmit={onSubmitToken} className="gate-form">
            <label>
              Access Token
              <input
                placeholder="rlm_xxx.yyy"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                autoComplete="off"
              />
            </label>
            <button type="submit" disabled={authPhase === "checking"}>
              {authPhase === "checking" ? "Unlocking..." : "Unlock Workspace"}
            </button>
          </form>
          {authError ? <p className="gate-error">{authError}</p> : null}
          <p className="gate-hint">API base: {API_BASE || "not configured"}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="workspace-shell">
      <header className="app-topbar">
        <div className="topbar-title">
          <p className="topbar-eyebrow">remote-llm workspace</p>
          <h1>Codex Control App</h1>
        </div>
        <div className="topbar-controls">
          <div className="mode-switch">
            <button
              type="button"
              className={appMode === "session" ? "mode-btn active" : "mode-btn"}
              onClick={() => switchMode("session")}
            >
              Session
            </button>
            <button
              type="button"
              className={appMode === "ops" ? "mode-btn active" : "mode-btn"}
              onClick={() => switchMode("ops")}
            >
              Ops
            </button>
          </div>
          <span
            className={`sync-pill ${isRefreshing ? "busy" : healthIsError ? "error" : "ok"}`}
          >
            {syncLabel}
          </span>
          <button
            onClick={() => void onRefreshWorkspace()}
            disabled={isRefreshing}
          >
            {isRefreshing ? "Syncing..." : "Sync"}
          </button>
          <button className="ghost" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      {healthIsError ? (
        <section className="workspace-alert">
          Controller state degraded: {health}
        </section>
      ) : null}

      {appMode === "session" ? (
        <div className="session-stage">
          <aside className="session-side codex-sidebar">
            <section className="inspect-block focus-block">
              <div className="pane-title-line">
                <h3>Projects</h3>
                <button
                  type="button"
                  className="ghost new-thread"
                  onClick={createThreadAndFocus}
                >
                  New
                </button>
              </div>
              <label className="tree-filter">
                <input
                  value={projectFilter}
                  onChange={(event) => setProjectFilter(event.target.value)}
                  placeholder="Filter projects or sessions"
                />
              </label>
              <div className="project-tree">
                {sessionTreeHosts.length === 0 ? (
                  <p className="pane-subtle-light">
                    No servers/projects discovered yet.
                  </p>
                ) : filteredSessionTreeHosts.length === 0 ? (
                  <p className="pane-subtle-light">
                    No matching projects or sessions.
                  </p>
                ) : (
                  filteredSessionTreeHosts.map((hostNode) => {
                    const isCollapsed = collapsedHostIDs.includes(
                      hostNode.hostID,
                    );
                    return (
                      <article
                        key={hostNode.hostID}
                        className="project-host-group"
                      >
                        <header className="project-host-head">
                          <div className="project-host-headline">
                            <strong>{hostNode.hostName}</strong>
                            {hostNode.hostAddress ? (
                              <small>{hostNode.hostAddress}</small>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className="ghost host-toggle"
                            onClick={() => toggleHostCollapsed(hostNode.hostID)}
                          >
                            {isCollapsed ? "Expand" : "Collapse"}
                          </button>
                        </header>
                        {isCollapsed ? null : hostNode.projects.length === 0 ? (
                          <p className="pane-subtle-light compact-empty">
                            No projects available.
                          </p>
                        ) : (
                          hostNode.projects.map((projectNode) => (
                            <div key={projectNode.id} className="project-node">
                              <button
                                type="button"
                                className={`project-chip ${projectNode.id === activeWorkspaceID ? "active" : ""}`}
                                onClick={() =>
                                  setActiveWorkspaceID(projectNode.id)
                                }
                                title={projectNode.path}
                              >
                                <span className="project-chip-main">
                                  <strong>
                                    {compactPath(projectNode.path)}
                                  </strong>
                                  <em>{projectNode.path}</em>
                                </span>
                                <small>
                                  {projectNode.sessions.length === 0
                                    ? "empty"
                                    : `${projectNode.sessions.length}`}
                                </small>
                              </button>
                              <div className="project-session-list">
                                {projectNode.sessions.length === 0 ? (
                                  <p className="pane-subtle-light compact-empty">
                                    No sessions in this project.
                                  </p>
                                ) : (
                                  projectNode.sessions.map((sessionNode) => (
                                    <button
                                      key={sessionNode.id}
                                      type="button"
                                      ref={(node) =>
                                        registerSessionButtonRef(sessionNode.id, node)
                                      }
                                      className={`session-chip-tree ${sessionNode.id === activeThreadID ? "active" : ""}`}
                                      data-session-id={sessionNode.id}
                                      data-pinned={sessionNode.pinned ? "true" : "false"}
                                      tabIndex={
                                        treeCursorSessionID === sessionNode.id ? 0 : -1
                                      }
                                      onClick={(event) => {
                                        if (event.metaKey || event.ctrlKey) {
                                          event.preventDefault();
                                          setThreadPinned(
                                            sessionNode.id,
                                            !sessionNode.pinned,
                                          );
                                          return;
                                        }
                                        setTreeCursorSessionID(sessionNode.id);
                                        activateThread(sessionNode.id);
                                      }}
                                      onFocus={() =>
                                        setTreeCursorSessionID(sessionNode.id)
                                      }
                                      onKeyDown={(event) =>
                                        onSessionTreeKeyDown(
                                          event,
                                          sessionNode.id,
                                          sessionNode.pinned,
                                        )
                                      }
                                      title={sessionNode.title}
                                    >
                                      <span className="session-chip-label">
                                        {sessionNode.title}
                                      </span>
                                      <span className="session-chip-state">
                                        {sessionNode.pinned ? (
                                          <small className="session-chip-badge pinned">
                                            pin
                                          </small>
                                        ) : null}
                                        {sessionNode.activeJobID ? (
                                          <small className="session-chip-badge running">
                                            running
                                          </small>
                                        ) : null}
                                        {sessionNode.unreadDone ? (
                                          <small className="session-chip-badge unread">
                                            new
                                          </small>
                                        ) : null}
                                        {!sessionNode.activeJobID &&
                                        !sessionNode.unreadDone &&
                                        sessionNode.lastJobStatus !== "idle" ? (
                                          <small className="session-chip-badge status">
                                            {sessionNode.lastJobStatus}
                                          </small>
                                        ) : null}
                                      </span>
                                    </button>
                                  ))
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </article>
                    );
                  })
                )}
              </div>
            </section>

            <section className="inspect-block compact-session-meta">
              <p className="pane-subtle-light">
                Ctrl/Cmd+K focus · Enter send · Shift+Enter newline ·
                Ctrl/Cmd+Shift+N new session · P pin (on focused session)
              </p>
              <div className="ops-actions-row">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void onEnableNotifications()}
                >
                  Alerts: {notificationPermission}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setSessionAlertsExpanded((prev) => !prev)}
                  disabled={sessionAlerts.length === 0}
                >
                  Notifications {sessionAlerts.length > 0 ? `(${sessionAlerts.length})` : ""}
                </button>
              </div>
              {sessionAlerts.length === 0 ? (
                <p className="pane-subtle-light">No notifications yet.</p>
              ) : sessionAlertsExpanded ? (
                <div className="notification-center">
                  <div className="notification-head">
                    <strong>Recent</strong>
                    <button
                      type="button"
                      className="ghost"
                      onClick={clearSessionAlerts}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="notification-list" role="status" aria-live="polite">
                    {sessionAlerts
                      .slice(Math.max(0, sessionAlerts.length - 8))
                      .reverse()
                      .map((alert) => (
                        <button
                          key={alert.id}
                          type="button"
                          className="session-alert"
                          onClick={() => openSessionFromAlert(alert)}
                        >
                          <strong>{alert.title}</strong>
                          <span>{alert.body}</span>
                        </button>
                      ))}
                  </div>
                </div>
              ) : null}
            </section>
          </aside>

          <main className="chat-pane">
            <header className="chat-head">
              <div>
                <h1>{activeThread?.title ?? "Session"}</h1>
                <p className="chat-context">
                  {(activeWorkspace?.hostName?.trim() || "local-default") +
                    " · " +
                    (activeWorkspace?.path?.trim() || "/home/ecs-user")}
                </p>
              </div>
              <div className="chat-head-side">
                <span
                  className={`stream-pill ${activeStreamTone}`}
                  data-testid="stream-status"
                  title={activeStreamLastError || `stream ${activeStreamCopy}`}
                >
                  stream {activeStreamCopy}
                </span>
                <button
                  type="button"
                  className="ghost danger-ghost stream-reconnect-btn"
                  disabled={!activeThread || activeThreadBusy}
                  onClick={() => void onArchiveActiveSession()}
                >
                  {activeThread && deletingThreadID === activeThread.id
                    ? "Archiving..."
                    : "Archive"}
                </button>
                <button
                  type="button"
                  className="ghost stream-reconnect-btn"
                  disabled={!canReconnectActiveStream}
                  onClick={onReconnectActiveStream}
                >
                  Reconnect
                </button>
              </div>
            </header>

            <section
              className="timeline"
              aria-live="polite"
              ref={timelineViewportRef}
              onScroll={onTimelineScroll}
            >
              {activeTimeline.length === 0 ? (
                <article className="message message-system">
                  <div className="message-title-row">
                    <h4>{isRefreshing ? "Loading" : "Start"}</h4>
                  </div>
                  <pre>
                    {isRefreshing
                      ? "Preparing session..."
                      : "Ask Codex what to do in this workspace."}
                  </pre>
                </article>
              ) : (
                activeTimeline.map((entry) => (
                  <article
                    key={entry.id}
                    className={`message message-${entry.kind} ${entry.state ? `message-${entry.state}` : ""}`}
                  >
                    <div className="message-title-row">
                      <h4>{entry.title}</h4>
                      <time>{formatClock(entry.createdAt)}</time>
                    </div>
                    {renderTimelineEntryBody(entry)}
                  </article>
                ))
              )}
              <div ref={timelineBottomRef} />
            </section>

            <form
              ref={composerFormRef}
              className="composer"
              onSubmit={onSendPrompt}
            >
              {activeThreadStatusCopy ? (
                <p className="composer-status" role="status">
                  {activeThreadStatusCopy}
                </p>
              ) : null}
              <div className="session-inline-settings">
                <label className="session-setting-row">
                  model
                  <select
                    value={activeThreadModelValue}
                    disabled={
                      !activeThread || !hasSessionModelChoices || activeThreadBusy
                    }
                    onChange={(event) => {
                      if (!activeThread) return;
                      setThreadModel(activeThread.id, event.target.value);
                    }}
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
                  {!hasSessionModelChoices ? (
                    <small className="pane-subtle-light">
                      No models discovered on this server.
                    </small>
                  ) : null}
                </label>
                <label className="session-setting-row">
                  sandbox
                  <select
                    value={activeThread?.sandbox ?? "workspace-write"}
                    disabled={!activeThread || activeThreadBusy}
                    onChange={(event) =>
                      activeThread &&
                      setThreadSandbox(
                        activeThread.id,
                        event.target.value as
                          | ""
                          | "read-only"
                          | "workspace-write"
                          | "danger-full-access",
                      )
                    }
                  >
                    <option value="read-only">read-only</option>
                    <option value="workspace-write">workspace-write</option>
                    <option value="danger-full-access">
                      danger-full-access
                    </option>
                  </select>
                </label>
              </div>

              <div className="quick-strip">
                <label
                  className={`quick-chip ghost file-chip ${
                    uploadingImage || !activeThread || activeThreadBusy
                      ? "disabled"
                      : ""
                  }`}
                >
                  <input
                    type="file"
                    accept="image/*"
                    disabled={uploadingImage || !activeThread || activeThreadBusy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      void onUploadSessionImage(file);
                      event.currentTarget.value = "";
                    }}
                  />
                  {uploadingImage ? "uploading..." : "Attach Image"}
                </label>
                {(activeThread?.imagePaths ?? []).map((imagePath) => (
                  <button
                    key={imagePath}
                    type="button"
                    className="quick-chip ghost"
                    onClick={() =>
                      activeThread &&
                      removeThreadImagePath(activeThread.id, imagePath)
                    }
                  >
                    {imagePath.split("/").pop() ?? imagePath} ×
                  </button>
                ))}
                {imageUploadError ? (
                  <span className="shortcut-hint">{imageUploadError}</span>
                ) : null}
              </div>

              <textarea
                ref={promptInputRef}
                value={activeDraft}
                onChange={(event) => {
                  if (activeThread) {
                    updateThreadDraft(activeThread.id, event.target.value);
                  }
                }}
                rows={1}
                placeholder={
                  activeThread
                    ? "Tell codex what to do in this workspace..."
                    : "Select a session to start"
                }
                disabled={!activeThread}
                onKeyDown={(event) => {
                  const composing =
                    "isComposing" in event.nativeEvent
                      ? Boolean(
                          (event.nativeEvent as { isComposing?: boolean })
                            .isComposing,
                        )
                      : false;
                  if (event.key === "Enter" && !event.shiftKey && !composing) {
                    event.preventDefault();
                    composerFormRef.current?.requestSubmit();
                  }
                }}
              />

              <div className="composer-actions">
                <button
                  type="submit"
                  disabled={activeThreadBusy || !activeThread}
                >
                  {activeThreadBusy ? "Running..." : "Send"}
                </button>
              </div>
            </form>
          </main>
        </div>
      ) : (
        <div className="ops-stage">
          <aside className="nav-pane">
            <header className="pane-head">
              <p className="pane-eyebrow">remote operations</p>
              <h2>Hosts and Runtime Control</h2>
              <p className="pane-subtle">health: {health}</p>
            </header>

            <section className="pane-block">
              <div className="pane-title-line">
                <h3>Targets</h3>
                <label className="switch-inline">
                  <input
                    type="checkbox"
                    checked={allHosts}
                    onChange={(event) => setAllHosts(event.target.checked)}
                  />
                  all
                </label>
              </div>
              <p className="pane-subtle">selected={selectedHostCount}</p>
              <label>
                filter
                <input
                  placeholder="name / host / user / workspace"
                  value={hostFilter}
                  onChange={(event) => setHostFilter(event.target.value)}
                />
              </label>
              <div className="target-list">
                {hosts.length === 0 ? (
                  <p className="pane-subtle">No hosts configured.</p>
                ) : filteredHosts.length === 0 ? (
                  <p className="pane-subtle">No hosts match filter.</p>
                ) : (
                  filteredHosts.map((host) => (
                    <div key={host.id} className="target-item">
                      <label className="target-checkline">
                        <input
                          type="checkbox"
                          disabled={allHosts}
                          checked={
                            allHosts || selectedHostIDs.includes(host.id)
                          }
                          onChange={() => toggleHostSelection(host.id)}
                        />
                        <span className="target-meta">
                          <strong>{host.name}</strong>
                          <small>
                            {host.user ? `${host.user}@` : ""}
                            {host.host}:{host.port}
                            {` mode=${host.connection_mode ?? "ssh"}`}
                          </small>
                        </span>
                      </label>
                      <div className="target-actions">
                        <button
                          type="button"
                          className="ghost"
                          disabled={opsHostBusyID === host.id}
                          onClick={() => void onProbeHost(host)}
                        >
                          {opsHostBusyID === host.id ? "..." : "Probe"}
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          disabled={opsHostBusyID === host.id}
                          onClick={() => onStartEditHost(host)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="ghost danger-ghost"
                          disabled={opsHostBusyID === host.id}
                          onClick={() => void onDeleteHost(host)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="pane-block">
              <h3>Runtime</h3>
              <label>
                runtime
                <select
                  value={selectedRuntime}
                  onChange={(event) => setSelectedRuntime(event.target.value)}
                >
                  {runtimes.map((runtime) => (
                    <option key={runtime.name} value={runtime.name}>
                      {runtime.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                sandbox
                <select
                  value={runSandbox}
                  onChange={(event) =>
                    setRunSandbox(
                      event.target.value as
                        | ""
                        | "read-only"
                        | "workspace-write"
                        | "danger-full-access",
                    )
                  }
                >
                  <option value="">default</option>
                  <option value="read-only">read-only</option>
                  <option value="workspace-write">workspace-write</option>
                  <option value="danger-full-access">danger-full-access</option>
                </select>
              </label>
              <label className="switch-inline">
                <input
                  type="checkbox"
                  checked={runAsyncMode}
                  onChange={(event) => setRunAsyncMode(event.target.checked)}
                />
                async queue
              </label>
            </section>

            <section className="pane-block">
              <h3>Queue Control</h3>
              <ul className="metric-list">
                <li>pending={metrics?.jobs.pending ?? "-"}</li>
                <li>running={metrics?.jobs.running ?? "-"}</li>
                <li>depth={metrics?.queue.depth ?? "-"}</li>
              </ul>
              <div className="ops-actions-row">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void onRefreshWorkspace()}
                  disabled={isRefreshing}
                >
                  {isRefreshing ? "Refreshing..." : "Refresh Queue"}
                </button>
                <button
                  type="button"
                  className="ghost danger-ghost"
                  disabled={!activeJob || !isJobActive(activeJob)}
                  onClick={() =>
                    activeJob ? void onCancelJob(activeJob) : undefined
                  }
                >
                  Cancel Active
                </button>
              </div>
            </section>

            <section className="pane-block">
              <h3>Overview</h3>
              <ul className="metric-list">
                <li>hosts={hosts.length}</li>
                <li>jobs={jobs.length}</li>
                <li>runs={runs.length}</li>
                <li>queue_depth={metrics?.queue.depth ?? "-"}</li>
                <li>
                  workers={metrics?.queue.workers_active ?? "-"}/
                  {metrics?.queue.workers_total ?? "-"}
                </li>
                <li>threads={threads.length}</li>
              </ul>
            </section>

            {opsNotice ? (
              <section
                className={`pane-block ops-notice ${opsNoticeIsError ? "ops-notice-error" : ""}`}
              >
                <h3>Ops Notice</h3>
                <p>{opsNotice}</p>
              </section>
            ) : null}
          </aside>

          <aside className="inspect-pane">
            {isRefreshing ? (
              <section className="inspect-block">
                <h3>Loading</h3>
                <p className="pane-subtle-light">
                  Refreshing hosts, queue, runs, and audit timeline...
                </p>
              </section>
            ) : null}

            <section className="inspect-block">
              <h3>Active Job</h3>
              {activeJob ? (
                <div className="job-card">
                  <div className="job-head">
                    <strong>{activeJob.id}</strong>
                    <span className={`tone-${statusTone(activeJob.status)}`}>
                      {activeJob.status}
                    </span>
                  </div>
                  <p>runtime={activeJob.runtime}</p>
                  <p>thread={activeJobThreadID}</p>
                  <p>queued={formatDateTime(activeJob.queued_at)}</p>
                  <p>
                    hosts total={activeJob.total_hosts ?? 0} ok=
                    {activeJob.succeeded_hosts ?? 0} failed=
                    {activeJob.failed_hosts ?? 0}
                  </p>
                  <div className="progress-track" aria-label="job progress">
                    <span style={{ width: `${activeProgress}%` }} />
                  </div>
                  <p>http={activeJob.result_status ?? "n/a"}</p>
                  {activeJob.error ? (
                    <p className="tone-err">{activeJob.error}</p>
                  ) : null}
                </div>
              ) : (
                <p className="pane-subtle-light">No active async job.</p>
              )}
            </section>

            <section className="inspect-block">
              <h3>Recent Jobs</h3>
              <div className="ops-filter-row">
                <label>
                  status
                  <select
                    value={opsJobStatusFilter}
                    onChange={(event) =>
                      setOpsJobStatusFilter(
                        event.target.value as
                          | "all"
                          | "pending"
                          | "running"
                          | "succeeded"
                          | "failed"
                          | "canceled",
                      )
                    }
                  >
                    <option value="all">all</option>
                    <option value="pending">pending</option>
                    <option value="running">running</option>
                    <option value="succeeded">succeeded</option>
                    <option value="failed">failed</option>
                    <option value="canceled">canceled</option>
                  </select>
                </label>
                <label>
                  type
                  <select
                    value={opsJobTypeFilter}
                    onChange={(event) =>
                      setOpsJobTypeFilter(
                        event.target.value as "all" | "run" | "sync",
                      )
                    }
                  >
                    <option value="all">all</option>
                    <option value="run">run</option>
                    <option value="sync">sync</option>
                  </select>
                </label>
              </div>
              {filteredOpsJobs.length === 0 ? (
                <p className="pane-subtle-light">No jobs yet.</p>
              ) : (
                <ul className="history-list">
                  {filteredOpsJobs.slice(0, 8).map((job) => (
                    <li key={job.id}>
                      <div className="history-item-main">
                        <button
                          className="ghost"
                          onClick={() => {
                            setActiveJobID(job.id);
                            setActiveJob(job);
                          }}
                        >
                          {job.id}
                        </button>
                        <span className={`tone-${statusTone(job.status)}`}>
                          {job.status}
                        </span>
                        <span>{job.type}</span>
                      </div>
                      <div className="history-item-actions">
                        {isJobActive(job) ? (
                          <button
                            type="button"
                            className="ghost danger-ghost"
                            onClick={() => void onCancelJob(job)}
                          >
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="inspect-block">
              <h3>Recent Runs</h3>
              <div className="ops-filter-row">
                <label>
                  status
                  <select
                    value={opsRunStatusFilter}
                    onChange={(event) =>
                      setOpsRunStatusFilter(
                        event.target.value as "all" | "ok" | "error",
                      )
                    }
                  >
                    <option value="all">all</option>
                    <option value="ok">ok</option>
                    <option value="error">error</option>
                  </select>
                </label>
              </div>
              {filteredOpsRuns.length === 0 ? (
                <p className="pane-subtle-light">No run results yet.</p>
              ) : (
                <ul className="history-list history-runs">
                  {filteredOpsRuns.slice(0, 8).map((run) => (
                    <li key={run.id}>
                      <span>{run.id}</span>
                      <span
                        className={`tone-${run.status_code < 400 ? "ok" : "err"}`}
                      >
                        {run.status_code < 400
                          ? "ok"
                          : `http_${run.status_code}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="inspect-block">
              <h3>Audit Timeline</h3>
              <div className="ops-filter-row">
                <label>
                  method
                  <select
                    value={opsAuditMethodFilter}
                    onChange={(event) =>
                      setOpsAuditMethodFilter(
                        event.target.value as "all" | "GET" | "POST" | "DELETE",
                      )
                    }
                  >
                    <option value="all">all</option>
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="DELETE">DELETE</option>
                  </select>
                </label>
                <label>
                  status
                  <select
                    value={opsAuditStatusFilter}
                    onChange={(event) =>
                      setOpsAuditStatusFilter(
                        event.target.value as "all" | "2xx" | "4xx" | "5xx",
                      )
                    }
                  >
                    <option value="all">all</option>
                    <option value="2xx">2xx</option>
                    <option value="4xx">4xx</option>
                    <option value="5xx">5xx</option>
                  </select>
                </label>
              </div>
              {filteredAuditEvents.length === 0 ? (
                <p className="pane-subtle-light">
                  No audit events with current filters.
                </p>
              ) : (
                <ul className="history-list">
                  {filteredAuditEvents.slice(0, 12).map((evt) => (
                    <li key={evt.id}>
                      <div className="history-item-main">
                        <span>{evt.action}</span>
                        <span>
                          {evt.method} {evt.path}
                        </span>
                      </div>
                      <span
                        className={`tone-${evt.status_code < 400 ? "ok" : "err"}`}
                      >
                        {evt.status_code}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="inspect-block">
              <h3>{editingHostID ? "Edit Host" : "Add Host"}</h3>
              <form className="host-form" onSubmit={onAddHost}>
                <input
                  placeholder="name"
                  value={hostForm.name}
                  onChange={(event) =>
                    setHostForm((prev) => ({
                      ...prev,
                      name: event.target.value,
                    }))
                  }
                />
                <label>
                  connection mode
                  <select
                    value={hostForm.connectionMode}
                    onChange={(event) =>
                      setHostForm((prev) => ({
                        ...prev,
                        connectionMode: event.target.value as "ssh" | "local",
                      }))
                    }
                  >
                    <option value="ssh">ssh</option>
                    <option value="local">local</option>
                  </select>
                </label>
                <input
                  placeholder={
                    hostForm.connectionMode === "local"
                      ? "host (optional for local mode)"
                      : "host"
                  }
                  value={hostForm.host}
                  onChange={(event) =>
                    setHostForm((prev) => ({
                      ...prev,
                      host: event.target.value,
                    }))
                  }
                />
                <input
                  placeholder="user"
                  value={hostForm.user}
                  onChange={(event) =>
                    setHostForm((prev) => ({
                      ...prev,
                      user: event.target.value,
                    }))
                  }
                />
                <input
                  placeholder="workspace"
                  value={hostForm.workspace}
                  onChange={(event) =>
                    setHostForm((prev) => ({
                      ...prev,
                      workspace: event.target.value,
                    }))
                  }
                />
                <div className="ops-actions-row">
                  <button type="submit" disabled={addingHost}>
                    {addingHost
                      ? "Saving..."
                      : editingHostID
                        ? "Update Host"
                        : "Save Host"}
                  </button>
                  {editingHostID ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={onCancelHostEdit}
                    >
                      Cancel Edit
                    </button>
                  ) : null}
                </div>
              </form>
            </section>
          </aside>
        </div>
      )}

    </div>
  );
}
