import { type MutableRefObject, useEffect } from "react";
import {
  getMetrics,
  getRunJob,
  listAudit,
  listRunJobEvents,
  listRunJobs,
  listRuns,
  type AuditEvent,
  type Host,
  type MetricsResponse,
  type RunJobEvent,
  type RunJobRecord,
  type RunRecord,
  type RuntimeInfo,
} from "../../api";
import type { TimelineEntry } from "../../domains/session";
import { EMPTY_ASSISTANT_FALLBACK } from "./config";
import {
  parseCodexAssistantTextFromStdout,
  parseCodexSessionTitleFromStdout,
} from "./codex-parsing";
import { ensureSessionRunState, surfaceRuntimeCardsFromRunState } from "./session-run-events";
import type { SessionRunStreamState } from "./stream-types";
import { extractAssistantTextFromJob, isJobActive, jobHasTargetFailures, sessionCompletionCopy, summarizeTargetFailures } from "./runtime-utils";
import { clipStreamText } from "./utils";

type PollTarget = {
  threadID: string;
  jobID: string;
};

type UseSessionJobPollingArgs = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  appMode: "session" | "ops";
  runningJobPollTargets: PollTarget[];
  activeThreadID: string;
  hosts: Host[];
  runtimes: RuntimeInfo[];

  jobEventCursorRef: MutableRefObject<Map<string, number>>;
  jobStreamSeenRef: MutableRefObject<Map<string, boolean>>;
  jobNoTextFinalizeRetriesRef: MutableRefObject<Map<string, number>>;
  sessionRunStateRef: MutableRefObject<Map<string, SessionRunStreamState>>;
  threadTitleMapRef: MutableRefObject<Map<string, string>>;

  hasCompletedRun: (runID: string) => boolean;
  markRunCompleted: (runID: string) => boolean;
  shouldSurfaceCompletion: (createdAt?: string) => boolean;

  addTimelineEntry: (
    entry: Omit<TimelineEntry, "id" | "createdAt">,
    threadID?: string,
  ) => void;
  upsertAssistantStreamEntry: (threadID: string, body: string) => void;
  finalizeAssistantStreamEntry: (
    threadID: string,
    state: "success" | "error",
    body?: string,
  ) => void;
  setThreadTitle: (threadID: string, title: string) => void;
  setThreadJobState: (
    threadID: string,
    jobID: string,
    status?: "idle" | "running" | "succeeded" | "failed" | "canceled",
  ) => void;
  setThreadUnread: (threadID: string, unread: boolean) => void;

  notifySessionDone: (title: string, body: string) => void;
  pushSessionAlert: (alert: {
    threadID: string;
    title: string;
    body: string;
  }) => void;

  setActiveJobID: (jobID: string) => void;
  setActiveJob: (job: RunJobRecord | null) => void;

  setJobs: (jobs: RunJobRecord[]) => void;
  setRuns: (runs: RunRecord[]) => void;
  setAuditEvents: (audit: AuditEvent[]) => void;
  setMetrics: (metrics: MetricsResponse | null) => void;

  refreshProjectsFromSource: (
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError?: boolean,
  ) => Promise<void>;
};

function appendCodexStdoutChunk(state: SessionRunStreamState, chunk: string) {
  if (!chunk) return;
  state.stdout = `${state.stdout}${chunk}`;
  if (state.stdout.length > 220000) {
    const trim = state.stdout.length - 220000;
    state.stdout = state.stdout.slice(trim);
    state.eventParseOffset = Math.max(0, state.eventParseOffset - trim);
  }
}

export function useSessionJobPolling(args: UseSessionJobPollingArgs) {
  useEffect(() => {
    if (args.authPhase !== "ready" || !args.token.trim()) return;
    if (args.runningJobPollTargets.length === 0) return;

    let canceled = false;
    const poll = async () => {
      const pollingJobs = args.runningJobPollTargets;
      if (pollingJobs.length === 0) return;
      try {
        const jobResults = await Promise.all(
          pollingJobs.map(async (item) => {
            try {
              const after = args.jobEventCursorRef.current.get(item.jobID) ?? 0;
              const [job, eventFeed] = await Promise.all([
                getRunJob(args.token, item.jobID),
                listRunJobEvents(args.token, item.jobID, after, 240).catch(() => ({
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
                nextAfter: args.jobEventCursorRef.current.get(item.jobID) ?? 0,
              };
            }
          }),
        );
        if (canceled) return;

        let needsProjectRefresh = false;
        for (const result of jobResults) {
          const { item, job, error, events, nextAfter } = result;
          if (!job) {
            args.addTimelineEntry(
              {
                kind: "system",
                state: "error",
                title: "Session Update Failed",
                body: error,
              },
              item.threadID,
            );
            args.setThreadJobState(item.threadID, "", "failed");
            continue;
          }
          args.jobEventCursorRef.current.set(item.jobID, nextAfter);
          const alreadyCompleted = args.hasCompletedRun(item.jobID);
          const streamRunState = args.sessionRunStateRef.current.get(item.threadID);
          const preferSessionStream =
            streamRunState?.runID === item.jobID &&
            (streamRunState?.streamSeen || streamRunState?.assistantFinalized);

          let stdoutStream = "";
          const showLiveStream =
            !preferSessionStream &&
            args.appMode === "session" &&
            item.threadID === args.activeThreadID;
          const fallbackRunState =
            !preferSessionStream && job.runtime === "codex"
              ? ensureSessionRunState(
                  args.sessionRunStateRef,
                  item.threadID,
                  item.jobID,
                )
              : null;
          for (const event of events) {
            if (
              event.type === "target.stdout" &&
              typeof event.chunk === "string"
            ) {
              stdoutStream += event.chunk;
              if (fallbackRunState) {
                appendCodexStdoutChunk(fallbackRunState, event.chunk);
              }
            }
          }
          if (!alreadyCompleted && showLiveStream && fallbackRunState) {
            surfaceRuntimeCardsFromRunState(
              args.addTimelineEntry,
              item.threadID,
              item.jobID,
              fallbackRunState,
              true,
            );
          }
          if (!alreadyCompleted && showLiveStream && stdoutStream.trim()) {
            if (job.runtime === "codex") {
              const sourceStdout = fallbackRunState
                ? fallbackRunState.stdout
                : stdoutStream;
              const nextTitle = parseCodexSessionTitleFromStdout(sourceStdout);
              if (nextTitle) {
                args.setThreadTitle(item.threadID, nextTitle);
              }
              const contentOnly = parseCodexAssistantTextFromStdout(
                sourceStdout,
                false,
              );
              if (contentOnly.trim()) {
                args.jobStreamSeenRef.current.set(item.jobID, true);
                args.upsertAssistantStreamEntry(
                  item.threadID,
                  clipStreamText(contentOnly),
                );
              } else if (
                sourceStdout.includes('"type":"turn.started"') ||
                sourceStdout.includes('"type":"thread.started"')
              ) {
                args.jobStreamSeenRef.current.set(item.jobID, true);
              }
            } else {
              args.jobStreamSeenRef.current.set(item.jobID, true);
              args.upsertAssistantStreamEntry(
                item.threadID,
                clipStreamText(stdoutStream),
              );
            }
          }
          if (item.threadID === args.activeThreadID) {
            args.setActiveJob(job);
            args.setActiveJobID(job.id);
          }

          if (isJobActive(job)) {
            args.setThreadJobState(item.threadID, job.id, "running");
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
              args.jobNoTextFinalizeRetriesRef.current.get(job.id) ?? 0;
            if (retries < 4) {
              args.jobNoTextFinalizeRetriesRef.current.set(job.id, retries + 1);
              args.setThreadJobState(item.threadID, job.id, "running");
              continue;
            }
          } else {
            args.jobNoTextFinalizeRetriesRef.current.delete(job.id);
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
          const shouldSurfaceJobCompletion = args.shouldSurfaceCompletion(
            job.finished_at || job.started_at || job.queued_at,
          );
          args.setThreadJobState(item.threadID, "", terminalStatus);
          args.jobEventCursorRef.current.delete(item.jobID);
          args.jobNoTextFinalizeRetriesRef.current.delete(job.id);
          const pollRunState = args.sessionRunStateRef.current.get(item.threadID);
          if (!preferSessionStream && pollRunState?.runID === item.jobID) {
            args.sessionRunStateRef.current.delete(item.threadID);
          }
          const sawSessionStream =
            streamRunState?.runID === item.jobID &&
            (streamRunState.streamSeen || streamRunState.assistantFinalized);
          const sawJobStream = Boolean(args.jobStreamSeenRef.current.get(item.jobID));
          args.jobStreamSeenRef.current.delete(item.jobID);
          const sawAnyStream = Boolean(sawSessionStream || sawJobStream);
          if (shouldSurfaceJobCompletion && item.threadID !== args.activeThreadID) {
            args.setThreadUnread(item.threadID, true);
          }

          if (args.hasCompletedRun(job.id)) {
            if (job.status === "succeeded") {
              if (assistantText) {
                if (sawAnyStream) {
                  args.finalizeAssistantStreamEntry(
                    item.threadID,
                    "success",
                    assistantText,
                  );
                }
              } else if (sawAnyStream) {
                args.finalizeAssistantStreamEntry(
                  item.threadID,
                  "success",
                  EMPTY_ASSISTANT_FALLBACK,
                );
              }
            }
            continue;
          }

          args.markRunCompleted(job.id);
          {
            const failedSummary = summarizeTargetFailures(job);
            if (
              job.status === "failed" ||
              job.status === "canceled" ||
              responseFailed
            ) {
              if (sawAnyStream) {
                args.finalizeAssistantStreamEntry(item.threadID, "error");
              }
              args.addTimelineEntry(
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
              if (sawAnyStream) {
                args.finalizeAssistantStreamEntry(
                  item.threadID,
                  "success",
                  assistantText,
                );
              } else {
                args.addTimelineEntry(
                  {
                    kind: "assistant",
                    state: "success",
                    title: "Assistant",
                    body: assistantText,
                  },
                  item.threadID,
                );
              }
            } else if (sawAnyStream) {
              args.finalizeAssistantStreamEntry(
                item.threadID,
                "success",
                EMPTY_ASSISTANT_FALLBACK,
              );
            }
            const sessionTitle =
              args.threadTitleMapRef.current.get(item.threadID) ?? "Session";
            const completionStatus: "succeeded" | "failed" | "canceled" =
              job.status === "canceled"
                ? "canceled"
                : job.status === "succeeded" && !responseFailed
                  ? "succeeded"
                  : "failed";
            const completion = sessionCompletionCopy(completionStatus);
            if (shouldSurfaceJobCompletion) {
              args.notifySessionDone(
                `${sessionTitle} ${completion.suffix}`,
                completion.body,
              );
              args.pushSessionAlert({
                threadID: item.threadID,
                title: `${sessionTitle} ${completion.suffix}`,
                body: completion.body,
              });
            }
          }
        }

        const [nextJobs, nextRuns, nextAudit, refreshedMetrics] =
          await Promise.all([
            listRunJobs(args.token, 20),
            listRuns(args.token, 20),
            listAudit(args.token, 80),
            getMetrics(args.token),
          ]);
        if (canceled) return;
        args.setJobs(nextJobs);
        args.setRuns(nextRuns);
        args.setAuditEvents(nextAudit);
        args.setMetrics(refreshedMetrics);
        if (needsProjectRefresh) {
          await args.refreshProjectsFromSource(
            args.token,
            args.hosts,
            args.runtimes.some((runtime) => runtime.name === "codex"),
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
    args.authPhase,
    args.token,
    args.appMode,
    args.runningJobPollTargets,
    args.activeThreadID,
    args.hosts,
    args.runtimes,
    args.hasCompletedRun,
    args.markRunCompleted,
    args.shouldSurfaceCompletion,
    args.addTimelineEntry,
    args.upsertAssistantStreamEntry,
    args.finalizeAssistantStreamEntry,
    args.setThreadTitle,
    args.setThreadJobState,
    args.setThreadUnread,
    args.notifySessionDone,
    args.pushSessionAlert,
    args.setActiveJobID,
    args.setActiveJob,
    args.setJobs,
    args.setRuns,
    args.setAuditEvents,
    args.setMetrics,
    args.refreshProjectsFromSource,
  ]);
}
