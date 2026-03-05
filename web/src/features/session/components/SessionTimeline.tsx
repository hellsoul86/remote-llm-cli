import { type MutableRefObject, type ReactNode } from "react";

import { type TimelineEntry } from "../../../domains/session";

type SessionTimelineProps = {
  timeline: TimelineEntry[];
  isRefreshing: boolean;
  renderTimelineEntryBody: (entry: TimelineEntry) => ReactNode;
  formatClock: (value: string) => string;
  timelineViewportRef: MutableRefObject<HTMLElement | null>;
  timelineBottomRef: MutableRefObject<HTMLDivElement | null>;
  onTimelineScroll: () => void;
  timelineUnreadCount: number;
  onJumpTimelineToLatest: () => void;
};

export function SessionTimeline({
  timeline,
  isRefreshing,
  renderTimelineEntryBody,
  formatClock,
  timelineViewportRef,
  timelineBottomRef,
  onTimelineScroll,
  timelineUnreadCount,
  onJumpTimelineToLatest,
}: SessionTimelineProps) {
  return (
    <div className="timeline-shell">
      <section
        className="timeline"
        aria-live="polite"
        ref={timelineViewportRef}
        onScroll={onTimelineScroll}
      >
        {timeline.length === 0 ? (
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
          timeline.map((entry) => (
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
      {timelineUnreadCount > 0 ? (
        <button
          type="button"
          className="timeline-jump-latest"
          data-testid="timeline-jump-latest"
          onClick={onJumpTimelineToLatest}
        >
          {timelineUnreadCount > 1
            ? `Jump to latest (${timelineUnreadCount})`
            : "Jump to latest"}
        </button>
      ) : null}
    </div>
  );
}
