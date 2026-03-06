import type { ComponentProps } from "react";

import { OpsControlSidebar } from "./components/OpsControlSidebar";
import { OpsInspectPane } from "./components/OpsInspectPane";
import { OpsStage } from "./components/OpsStage";

type OpsControlSidebarProps = ComponentProps<typeof OpsControlSidebar>;
type OpsInspectPaneProps = ComponentProps<typeof OpsInspectPane>;
type OpsStageProps = ComponentProps<typeof OpsStage>;

type BuildOpsStagePropsDeps = OpsControlSidebarProps &
  Pick<OpsInspectPaneProps, "isRefreshing" | "platformPanelProps"> &
  OpsInspectPaneProps["activeJobPanelProps"] &
  OpsInspectPaneProps["recentJobsPanelProps"] &
  OpsInspectPaneProps["recentRunsPanelProps"] &
  OpsInspectPaneProps["auditTimelinePanelProps"] &
  OpsInspectPaneProps["hostFormPanelProps"];

export function buildOpsStageProps(
  deps: BuildOpsStagePropsDeps,
): OpsStageProps {
  return {
    controlSidebarProps: {
      health: deps.health,
      allHosts: deps.allHosts,
      onAllHostsChange: deps.onAllHostsChange,
      selectedHostCount: deps.selectedHostCount,
      hostFilter: deps.hostFilter,
      onHostFilterChange: deps.onHostFilterChange,
      hosts: deps.hosts,
      filteredHosts: deps.filteredHosts,
      selectedHostIDs: deps.selectedHostIDs,
      onToggleHostSelection: deps.onToggleHostSelection,
      opsHostBusyID: deps.opsHostBusyID,
      onProbeHost: deps.onProbeHost,
      onStartEditHost: deps.onStartEditHost,
      onDeleteHost: deps.onDeleteHost,
      selectedRuntime: deps.selectedRuntime,
      onSelectedRuntimeChange: deps.onSelectedRuntimeChange,
      runtimes: deps.runtimes,
      runSandbox: deps.runSandbox,
      onRunSandboxChange: deps.onRunSandboxChange,
      runAsyncMode: deps.runAsyncMode,
      onRunAsyncModeChange: deps.onRunAsyncModeChange,
      metrics: deps.metrics,
      onRefreshWorkspace: deps.onRefreshWorkspace,
      isRefreshing: deps.isRefreshing,
      activeJob: deps.activeJob,
      onCancelJob: deps.onCancelJob,
      jobsLength: deps.jobsLength,
      runsLength: deps.runsLength,
      threadsLength: deps.threadsLength,
      opsNotice: deps.opsNotice,
      opsNoticeIsError: deps.opsNoticeIsError,
    },
    inspectPaneProps: {
      isRefreshing: deps.isRefreshing,
      platformPanelProps: deps.platformPanelProps,
      activeJobPanelProps: {
        activeJob: deps.activeJob,
        activeJobThreadID: deps.activeJobThreadID,
        activeProgress: deps.activeProgress,
      },
      recentJobsPanelProps: {
        opsJobStatusFilter: deps.opsJobStatusFilter,
        onOpsJobStatusFilterChange: deps.onOpsJobStatusFilterChange,
        opsJobTypeFilter: deps.opsJobTypeFilter,
        onOpsJobTypeFilterChange: deps.onOpsJobTypeFilterChange,
        filteredOpsJobs: deps.filteredOpsJobs,
        onSelectActiveJob: deps.onSelectActiveJob,
        onCancelJob: deps.onCancelJob,
      },
      recentRunsPanelProps: {
        opsRunStatusFilter: deps.opsRunStatusFilter,
        onOpsRunStatusFilterChange: deps.onOpsRunStatusFilterChange,
        filteredOpsRuns: deps.filteredOpsRuns,
      },
      auditTimelinePanelProps: {
        opsAuditMethodFilter: deps.opsAuditMethodFilter,
        onOpsAuditMethodFilterChange: deps.onOpsAuditMethodFilterChange,
        opsAuditStatusFilter: deps.opsAuditStatusFilter,
        onOpsAuditStatusFilterChange: deps.onOpsAuditStatusFilterChange,
        filteredAuditEvents: deps.filteredAuditEvents,
      },
      hostFormPanelProps: {
        editingHostID: deps.editingHostID,
        hostForm: deps.hostForm,
        onHostFormChange: deps.onHostFormChange,
        addingHost: deps.addingHost,
        onSubmit: deps.onSubmit,
        onCancelEdit: deps.onCancelEdit,
      },
    },
  };
}
