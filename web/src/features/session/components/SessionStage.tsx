import type { ComponentProps } from "react";

import { SessionComposer } from "./SessionComposer";
import { SessionHeader } from "./SessionHeader";
import { SessionReviewPane } from "./SessionReviewPane";
import { SessionSidebar } from "./SessionSidebar";
import { SessionTerminalDrawer } from "./SessionTerminalDrawer";
import { SessionTimeline } from "./SessionTimeline";

type SessionStageProps = {
  sidebarProps: ComponentProps<typeof SessionSidebar>;
  headerProps: ComponentProps<typeof SessionHeader>;
  timelineProps: ComponentProps<typeof SessionTimeline>;
  composerProps: ComponentProps<typeof SessionComposer>;
  terminalDrawerOpen: boolean;
  terminalDrawerProps: ComponentProps<typeof SessionTerminalDrawer> | null;
  reviewPaneOpen: boolean;
  reviewPaneProps: ComponentProps<typeof SessionReviewPane> | null;
};

export function SessionStage({
  sidebarProps,
  headerProps,
  timelineProps,
  composerProps,
  terminalDrawerOpen,
  terminalDrawerProps,
  reviewPaneOpen,
  reviewPaneProps,
}: SessionStageProps) {
  return (
    <div className={`session-stage${reviewPaneOpen ? " session-stage-review-open" : ""}`}>
      <SessionSidebar {...sidebarProps} />
      <main className={`chat-pane${terminalDrawerOpen ? " chat-pane-terminal-open" : ""}`}>
        <SessionHeader {...headerProps} />
        <SessionTimeline {...timelineProps} />
        {terminalDrawerOpen && terminalDrawerProps ? (
          <SessionTerminalDrawer {...terminalDrawerProps} />
        ) : null}
        <SessionComposer {...composerProps} />
      </main>
      {reviewPaneOpen && reviewPaneProps ? (
        <SessionReviewPane {...reviewPaneProps} />
      ) : null}
    </div>
  );
}
