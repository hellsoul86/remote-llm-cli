import type { ComponentProps } from "react";

import { SessionHeader } from "./components/SessionHeader";
import { SessionReviewPane } from "./components/SessionReviewPane";
import { SessionStage } from "./components/SessionStage";
import { SessionTerminalDrawer } from "./components/SessionTerminalDrawer";
import { SessionTimeline } from "./components/SessionTimeline";

type SessionStageProps = ComponentProps<typeof SessionStage>;
type SessionHeaderProps = ComponentProps<typeof SessionHeader>;
type SessionReviewPaneProps = ComponentProps<typeof SessionReviewPane>;
type SessionTerminalDrawerProps = ComponentProps<typeof SessionTerminalDrawer>;
type SessionTimelineProps = ComponentProps<typeof SessionTimeline>;

type BuildSessionStagePropsDeps = {
  sidebarProps: SessionStageProps["sidebarProps"];
  composerProps: SessionStageProps["composerProps"];
  headerTitle: string;
  headerContext: string;
  streamTone: string;
  streamCopy: string;
  streamLastError: string;
  terminalDrawerOpen: boolean;
  canToggleTerminal: boolean;
  onToggleTerminalDrawer: () => void;
  terminalWorkdir: SessionTerminalDrawerProps["workdir"];
  terminalHostLabel: SessionTerminalDrawerProps["hostLabel"];
  terminalCommands: SessionTerminalDrawerProps["commands"];
  terminalLiveStatus: SessionTerminalDrawerProps["liveStatus"];
  terminalLiveTransportAvailable: SessionTerminalDrawerProps["liveTransportAvailable"];
  terminalLiveOutput: SessionTerminalDrawerProps["liveOutput"];
  terminalLiveError: SessionTerminalDrawerProps["liveError"];
  onTerminalSendInput: SessionTerminalDrawerProps["onSendInput"];
  onTerminalResize: SessionTerminalDrawerProps["onResize"];
  onTerminalInterrupt: SessionTerminalDrawerProps["onInterrupt"];
  onTerminalReconnect: SessionTerminalDrawerProps["onReconnect"];
  onClearTerminalDrawer: SessionTerminalDrawerProps["onClear"];
  reviewPaneOpen: boolean;
  canToggleReview: boolean;
  onToggleReviewPane: () => void;
  reviewMode: SessionReviewPaneProps["mode"];
  reviewBusy: SessionReviewPaneProps["busy"];
  reviewUncommitted: SessionReviewPaneProps["reviewUncommitted"];
  reviewBase: SessionReviewPaneProps["reviewBase"];
  reviewCommit: SessionReviewPaneProps["reviewCommit"];
  reviewTitle: SessionReviewPaneProps["reviewTitle"];
  reviewTurnDiff: SessionReviewPaneProps["turnDiff"];
  reviewPatchDelta: SessionReviewPaneProps["patchDelta"];
  reviewChanges: SessionReviewPaneProps["changes"];
  reviewFindings: SessionReviewPaneProps["findings"];
  reviewGitStatusKnown: SessionReviewPaneProps["gitStatusKnown"];
  reviewGitStatusLoading: SessionReviewPaneProps["gitStatusLoading"];
  reviewGitStatusMessage: SessionReviewPaneProps["gitStatusMessage"];
  reviewGitStatusTone: SessionReviewPaneProps["gitStatusTone"];
  reviewChangedPaths: SessionReviewPaneProps["changedPaths"];
  reviewStagedPaths: SessionReviewPaneProps["stagedPaths"];
  reviewGitBusyAction: SessionReviewPaneProps["gitBusyAction"];
  onRefreshReviewGitStatus: SessionReviewPaneProps["onRefreshGitStatus"];
  onStageReviewChange: SessionReviewPaneProps["onStageChange"];
  onRevertReviewChange: SessionReviewPaneProps["onRevertChange"];
  onCommitReviewChanges: SessionReviewPaneProps["onCommitChanges"];
  canStartReview: SessionReviewPaneProps["canStartReview"];
  onStartReview: SessionReviewPaneProps["onStartReview"];
  onSetReviewMode: SessionReviewPaneProps["onSetMode"];
  onSetReviewUncommitted: SessionReviewPaneProps["onSetReviewUncommitted"];
  onSetReviewBase: SessionReviewPaneProps["onSetReviewBase"];
  onSetReviewCommit: SessionReviewPaneProps["onSetReviewCommit"];
  onSetReviewTitle: SessionReviewPaneProps["onSetReviewTitle"];
  canArchive: boolean;
  archiving: boolean;
  onArchive: () => Promise<void>;
  canReconnect: boolean;
  onReconnect: () => void;
  timeline: SessionTimelineProps["timeline"];
  isRefreshing: boolean;
  renderTimelineEntryBody: SessionTimelineProps["renderTimelineEntryBody"];
  formatClock: SessionTimelineProps["formatClock"];
  timelineViewportRef: SessionTimelineProps["timelineViewportRef"];
  timelineBottomRef: SessionTimelineProps["timelineBottomRef"];
  onTimelineScroll: SessionTimelineProps["onTimelineScroll"];
  timelineUnreadCount: number;
  onJumpTimelineToLatest: SessionTimelineProps["onJumpTimelineToLatest"];
};

export function buildSessionStageProps(
  deps: BuildSessionStagePropsDeps,
): SessionStageProps {
  const headerProps: SessionHeaderProps = {
    title: deps.headerTitle,
    context: deps.headerContext,
    streamTone: deps.streamTone,
    streamCopy: deps.streamCopy,
    streamLastError: deps.streamLastError,
    terminalOpen: deps.terminalDrawerOpen,
    canToggleTerminal: deps.canToggleTerminal,
    onToggleTerminalDrawer: deps.onToggleTerminalDrawer,
    reviewOpen: deps.reviewPaneOpen,
    canToggleReview: deps.canToggleReview,
    onToggleReviewPane: deps.onToggleReviewPane,
    canArchive: deps.canArchive,
    archiving: deps.archiving,
    onArchive: () => {
      void deps.onArchive();
    },
    canReconnect: deps.canReconnect,
    onReconnect: deps.onReconnect,
  };

  const timelineProps: SessionTimelineProps = {
    timeline: deps.timeline,
    isRefreshing: deps.isRefreshing,
    renderTimelineEntryBody: deps.renderTimelineEntryBody,
    formatClock: deps.formatClock,
    timelineViewportRef: deps.timelineViewportRef,
    timelineBottomRef: deps.timelineBottomRef,
    onTimelineScroll: deps.onTimelineScroll,
    timelineUnreadCount: deps.timelineUnreadCount,
    onJumpTimelineToLatest: deps.onJumpTimelineToLatest,
  };

  const terminalDrawerProps: SessionTerminalDrawerProps | null =
    deps.canToggleTerminal
      ? {
          workdir: deps.terminalWorkdir,
          hostLabel: deps.terminalHostLabel,
          commands: deps.terminalCommands,
          liveStatus: deps.terminalLiveStatus,
          liveTransportAvailable: deps.terminalLiveTransportAvailable,
          liveOutput: deps.terminalLiveOutput,
          liveError: deps.terminalLiveError,
          onSendInput: deps.onTerminalSendInput,
          onResize: deps.onTerminalResize,
          onInterrupt: deps.onTerminalInterrupt,
          onReconnect: deps.onTerminalReconnect,
          onClose: deps.onToggleTerminalDrawer,
          onClear: deps.onClearTerminalDrawer,
        }
      : null;

  const reviewPaneProps: SessionReviewPaneProps | null = deps.canToggleReview
    ? {
        mode: deps.reviewMode,
        busy: deps.reviewBusy,
        reviewUncommitted: deps.reviewUncommitted,
        reviewBase: deps.reviewBase,
        reviewCommit: deps.reviewCommit,
        reviewTitle: deps.reviewTitle,
        turnDiff: deps.reviewTurnDiff,
        patchDelta: deps.reviewPatchDelta,
        changes: deps.reviewChanges,
        findings: deps.reviewFindings,
        gitStatusKnown: deps.reviewGitStatusKnown,
        gitStatusLoading: deps.reviewGitStatusLoading,
        gitStatusMessage: deps.reviewGitStatusMessage,
        gitStatusTone: deps.reviewGitStatusTone,
        changedPaths: deps.reviewChangedPaths,
        stagedPaths: deps.reviewStagedPaths,
        gitBusyAction: deps.reviewGitBusyAction,
        onRefreshGitStatus: deps.onRefreshReviewGitStatus,
        onStageChange: deps.onStageReviewChange,
        onRevertChange: deps.onRevertReviewChange,
        onCommitChanges: deps.onCommitReviewChanges,
        canStartReview: deps.canStartReview,
        onStartReview: deps.onStartReview,
        onClose: deps.onToggleReviewPane,
        onSetMode: deps.onSetReviewMode,
        onSetReviewUncommitted: deps.onSetReviewUncommitted,
        onSetReviewBase: deps.onSetReviewBase,
        onSetReviewCommit: deps.onSetReviewCommit,
        onSetReviewTitle: deps.onSetReviewTitle,
      }
    : null;

  return {
    sidebarProps: deps.sidebarProps,
    headerProps,
    timelineProps,
    composerProps: deps.composerProps,
    terminalDrawerOpen: deps.terminalDrawerOpen,
    terminalDrawerProps,
    reviewPaneOpen: deps.reviewPaneOpen,
    reviewPaneProps,
  };
}
