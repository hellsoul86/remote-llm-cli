import type { ComponentProps } from "react";

import { SessionHeader } from "./components/SessionHeader";
import { SessionReviewPane } from "./components/SessionReviewPane";
import { SessionStage } from "./components/SessionStage";
import { SessionTimeline } from "./components/SessionTimeline";

type SessionStageProps = ComponentProps<typeof SessionStage>;
type SessionHeaderProps = ComponentProps<typeof SessionHeader>;
type SessionReviewPaneProps = ComponentProps<typeof SessionReviewPane>;
type SessionTimelineProps = ComponentProps<typeof SessionTimeline>;

type BuildSessionStagePropsDeps = {
  sidebarProps: SessionStageProps["sidebarProps"];
  composerProps: SessionStageProps["composerProps"];
  headerTitle: string;
  headerContext: string;
  streamTone: string;
  streamCopy: string;
  streamLastError: string;
  reviewPaneOpen: boolean;
  canToggleReview: boolean;
  onToggleReviewPane: () => void;
  reviewMode: SessionReviewPaneProps["mode"];
  reviewBusy: SessionReviewPaneProps["busy"];
  reviewUncommitted: SessionReviewPaneProps["reviewUncommitted"];
  reviewBase: SessionReviewPaneProps["reviewBase"];
  reviewCommit: SessionReviewPaneProps["reviewCommit"];
  reviewTitle: SessionReviewPaneProps["reviewTitle"];
  reviewFindings: SessionReviewPaneProps["findings"];
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

  const reviewPaneProps: SessionReviewPaneProps | null = deps.canToggleReview
    ? {
        mode: deps.reviewMode,
        busy: deps.reviewBusy,
        reviewUncommitted: deps.reviewUncommitted,
        reviewBase: deps.reviewBase,
        reviewCommit: deps.reviewCommit,
        reviewTitle: deps.reviewTitle,
        findings: deps.reviewFindings,
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
    reviewPaneOpen: deps.reviewPaneOpen,
    reviewPaneProps,
  };
}
