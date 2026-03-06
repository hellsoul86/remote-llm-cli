import type { ComponentProps } from "react";

import { SessionComposer } from "./SessionComposer";
import { SessionHeader } from "./SessionHeader";
import { SessionSidebar } from "./SessionSidebar";
import { SessionTimeline } from "./SessionTimeline";

type SessionStageProps = {
  sidebarProps: ComponentProps<typeof SessionSidebar>;
  headerProps: ComponentProps<typeof SessionHeader>;
  timelineProps: ComponentProps<typeof SessionTimeline>;
  composerProps: ComponentProps<typeof SessionComposer>;
};

export function SessionStage({
  sidebarProps,
  headerProps,
  timelineProps,
  composerProps,
}: SessionStageProps) {
  return (
    <div className="session-stage">
      <SessionSidebar {...sidebarProps} />
      <main className="chat-pane">
        <SessionHeader {...headerProps} />
        <SessionTimeline {...timelineProps} />
        <SessionComposer {...composerProps} />
      </main>
    </div>
  );
}
