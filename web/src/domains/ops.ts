import { useState } from "react";
import type { AuditEvent, Host, MetricsResponse, RunJobRecord, RunRecord, RuntimeInfo } from "../api";

export type AddHostForm = {
  name: string;
  host: string;
  user: string;
  workspace: string;
};

export function useOpsDomain() {
  const [health, setHealth] = useState("checking");
  const [hosts, setHosts] = useState<Host[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [jobs, setJobs] = useState<RunJobRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);

  const [selectedRuntime, setSelectedRuntime] = useState("codex");
  const [allHosts, setAllHosts] = useState(true);
  const [selectedHostIDs, setSelectedHostIDs] = useState<string[]>([]);
  const [runMode, setRunMode] = useState<"exec" | "resume" | "review">("exec");
  const [runModel, setRunModel] = useState("");
  const [runSandbox, setRunSandbox] = useState<"" | "read-only" | "workspace-write" | "danger-full-access">("");
  const [runAsyncMode, setRunAsyncMode] = useState(true);
  const [workdir, setWorkdir] = useState("");
  const [fanoutValue, setFanoutValue] = useState("3");
  const [maxOutputKB, setMaxOutputKB] = useState("256");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [activeJobID, setActiveJobID] = useState("");
  const [activeJob, setActiveJob] = useState<RunJobRecord | null>(null);

  const [hostForm, setHostForm] = useState<AddHostForm>({ name: "", host: "", user: "", workspace: "" });
  const [hostFilter, setHostFilter] = useState("");
  const [editingHostID, setEditingHostID] = useState("");
  const [addingHost, setAddingHost] = useState(false);
  const [opsHostBusyID, setOpsHostBusyID] = useState("");
  const [opsNotice, setOpsNotice] = useState("");
  const [opsJobStatusFilter, setOpsJobStatusFilter] = useState<"all" | "pending" | "running" | "succeeded" | "failed" | "canceled">(
    "all"
  );
  const [opsJobTypeFilter, setOpsJobTypeFilter] = useState<"all" | "run" | "sync">("all");
  const [opsRunStatusFilter, setOpsRunStatusFilter] = useState<"all" | "ok" | "error">("all");
  const [opsAuditMethodFilter, setOpsAuditMethodFilter] = useState<"all" | "GET" | "POST" | "DELETE">("all");
  const [opsAuditStatusFilter, setOpsAuditStatusFilter] = useState<"all" | "2xx" | "4xx" | "5xx">("all");

  function resetOpsDomain() {
    setHealth("checking");
    setHosts([]);
    setRuntimes([]);
    setJobs([]);
    setRuns([]);
    setAuditEvents([]);
    setMetrics(null);
    setSelectedRuntime("codex");
    setAllHosts(true);
    setSelectedHostIDs([]);
    setRunMode("exec");
    setRunModel("");
    setRunSandbox("");
    setRunAsyncMode(true);
    setWorkdir("");
    setFanoutValue("3");
    setMaxOutputKB("256");
    setIsSubmitting(false);
    setIsRefreshing(false);
    setActiveJobID("");
    setActiveJob(null);
    setHostForm({ name: "", host: "", user: "", workspace: "" });
    setHostFilter("");
    setEditingHostID("");
    setAddingHost(false);
    setOpsHostBusyID("");
    setOpsNotice("");
    setOpsJobStatusFilter("all");
    setOpsJobTypeFilter("all");
    setOpsRunStatusFilter("all");
    setOpsAuditMethodFilter("all");
    setOpsAuditStatusFilter("all");
  }

  return {
    health,
    setHealth,
    hosts,
    setHosts,
    runtimes,
    setRuntimes,
    jobs,
    setJobs,
    runs,
    setRuns,
    auditEvents,
    setAuditEvents,
    metrics,
    setMetrics,
    selectedRuntime,
    setSelectedRuntime,
    allHosts,
    setAllHosts,
    selectedHostIDs,
    setSelectedHostIDs,
    runMode,
    setRunMode,
    runModel,
    setRunModel,
    runSandbox,
    setRunSandbox,
    runAsyncMode,
    setRunAsyncMode,
    workdir,
    setWorkdir,
    fanoutValue,
    setFanoutValue,
    maxOutputKB,
    setMaxOutputKB,
    isSubmitting,
    setIsSubmitting,
    isRefreshing,
    setIsRefreshing,
    activeJobID,
    setActiveJobID,
    activeJob,
    setActiveJob,
    hostForm,
    setHostForm,
    hostFilter,
    setHostFilter,
    editingHostID,
    setEditingHostID,
    addingHost,
    setAddingHost,
    opsHostBusyID,
    setOpsHostBusyID,
    opsNotice,
    setOpsNotice,
    opsJobStatusFilter,
    setOpsJobStatusFilter,
    opsJobTypeFilter,
    setOpsJobTypeFilter,
    opsRunStatusFilter,
    setOpsRunStatusFilter,
    opsAuditMethodFilter,
    setOpsAuditMethodFilter,
    opsAuditStatusFilter,
    setOpsAuditStatusFilter,
    resetOpsDomain
  };
}
