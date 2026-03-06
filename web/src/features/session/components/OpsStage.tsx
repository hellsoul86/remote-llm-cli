import type { ComponentProps } from "react";

import { OpsControlSidebar } from "./OpsControlSidebar";
import { OpsInspectPane } from "./OpsInspectPane";

type OpsStageProps = {
  controlSidebarProps: ComponentProps<typeof OpsControlSidebar>;
  inspectPaneProps: ComponentProps<typeof OpsInspectPane>;
};

export function OpsStage({
  controlSidebarProps,
  inspectPaneProps,
}: OpsStageProps) {
  return (
    <div className="ops-stage">
      <OpsControlSidebar {...controlSidebarProps} />
      <OpsInspectPane {...inspectPaneProps} />
    </div>
  );
}
