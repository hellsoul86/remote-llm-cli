import type { ComponentProps } from "react";

import { SessionHeader } from "./components/SessionHeader";
import { SessionStage } from "./components/SessionStage";
import { SessionTimeline } from "./components/SessionTimeline";

type SessionStageProps = ComponentProps<typeof SessionStage>;
type SessionHeaderProps = ComponentProps<typeof SessionHeader>;
type SessionTimelineProps = ComponentProps<typeof SessionTimeline>;

type BuildSessionStagePropsDeps = {
  sidebarProps: SessionStageProps["sidebarProps"];
  composerProps: SessionStageProps["composerProps"];
  headerTitle: string;
  headerContext: string;
  streamTone: string;
  streamCopy: string;
  streamLastError: string;
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

  return {
    sidebarProps: deps.sidebarProps,
    headerProps,
    timelineProps,
    composerProps: deps.composerProps,
  };
}
