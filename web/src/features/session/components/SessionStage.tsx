import type { ComponentProps } from "react";

import { SessionComposer } from "./SessionComposer";
import { SessionHeader } from "./SessionHeader";
import { SessionReviewPane } from "./SessionReviewPane";
import { SessionSidebar } from "./SessionSidebar";
import { SessionTimeline } from "./SessionTimeline";

type SessionStageProps = {
  sidebarProps: ComponentProps<typeof SessionSidebar>;
  headerProps: ComponentProps<typeof SessionHeader>;
  timelineProps: ComponentProps<typeof SessionTimeline>;
  composerProps: ComponentProps<typeof SessionComposer>;
  reviewPaneOpen: boolean;
  reviewPaneProps: ComponentProps<typeof SessionReviewPane> | null;
};

export function SessionStage({
  sidebarProps,
  headerProps,
  timelineProps,
  composerProps,
  reviewPaneOpen,
  reviewPaneProps,
}: SessionStageProps) {
  return (
    <div className={`session-stage${reviewPaneOpen ? " session-stage-review-open" : ""}`}>
      <SessionSidebar {...sidebarProps} />
      <main className="chat-pane">
        <SessionHeader {...headerProps} />
        <SessionTimeline {...timelineProps} />
        <SessionComposer {...composerProps} />
      </main>
      {reviewPaneOpen && reviewPaneProps ? (
        <SessionReviewPane {...reviewPaneProps} />
      ) : null}
    </div>
  );
}
