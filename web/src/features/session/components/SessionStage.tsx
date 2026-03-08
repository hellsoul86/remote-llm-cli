import type { ComponentProps } from "react";

import { SessionComposer } from "./SessionComposer";
import { SessionHeader } from "./SessionHeader";
import { SessionReviewPane } from "./SessionReviewPane";
import { SessionSidebar } from "./SessionSidebar";
import { SessionTerminalDrawer } from "./SessionTerminalDrawer";
import { SessionTimeline } from "./SessionTimeline";

type SessionStageProps = {
  sidebarProps: ComponentProps<typeof SessionSidebar>;
  sidebarCollapsed: boolean;
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
  sidebarCollapsed,
  headerProps,
  timelineProps,
  composerProps,
  terminalDrawerOpen,
  terminalDrawerProps,
  reviewPaneOpen,
  reviewPaneProps,
}: SessionStageProps) {
  return (
    <div
      className={`session-stage${reviewPaneOpen ? " session-stage-review-open" : ""}${
        sidebarCollapsed ? " session-stage-sidebar-collapsed" : ""
      }`}
    >
      {!sidebarCollapsed ? <SessionSidebar {...sidebarProps} /> : null}
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
