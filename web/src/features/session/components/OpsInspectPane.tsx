import type { ComponentProps } from "react";

import { OpsActiveJobPanel } from "./OpsActiveJobPanel";
import { OpsAuditTimelinePanel } from "./OpsAuditTimelinePanel";
import { OpsCodexPlatformPanel } from "./OpsCodexPlatformPanel";
import { OpsHostFormPanel } from "./OpsHostFormPanel";
import { OpsRecentJobsPanel } from "./OpsRecentJobsPanel";
import { OpsRecentRunsPanel } from "./OpsRecentRunsPanel";

type OpsInspectPaneProps = {
  isRefreshing: boolean;
  platformPanelProps: ComponentProps<typeof OpsCodexPlatformPanel>;
  activeJobPanelProps: ComponentProps<typeof OpsActiveJobPanel>;
  recentJobsPanelProps: ComponentProps<typeof OpsRecentJobsPanel>;
  recentRunsPanelProps: ComponentProps<typeof OpsRecentRunsPanel>;
  auditTimelinePanelProps: ComponentProps<typeof OpsAuditTimelinePanel>;
  hostFormPanelProps: ComponentProps<typeof OpsHostFormPanel>;
};

export function OpsInspectPane({
  isRefreshing,
  platformPanelProps,
  activeJobPanelProps,
  recentJobsPanelProps,
  recentRunsPanelProps,
  auditTimelinePanelProps,
  hostFormPanelProps,
}: OpsInspectPaneProps) {
  return (
    <aside className="inspect-pane">
      {isRefreshing ? (
        <section className="inspect-block">
          <h3>Loading</h3>
          <p className="pane-subtle-light">
            Refreshing hosts, queue, runs, and audit timeline...
          </p>
        </section>
      ) : null}

      <OpsCodexPlatformPanel {...platformPanelProps} />
      <OpsActiveJobPanel {...activeJobPanelProps} />
      <OpsRecentJobsPanel {...recentJobsPanelProps} />
      <OpsRecentRunsPanel {...recentRunsPanelProps} />
      <OpsAuditTimelinePanel {...auditTimelinePanelProps} />
      <OpsHostFormPanel {...hostFormPanelProps} />
    </aside>
  );
}
