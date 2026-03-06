import type {
  Host,
  MetricsResponse,
  RunJobRecord,
  RuntimeInfo,
} from "../../../api";
import { isJobActive } from "../runtime-utils";

type OpsControlSidebarProps = {
  health: string;
  allHosts: boolean;
  onAllHostsChange: (value: boolean) => void;
  selectedHostCount: number;
  hostFilter: string;
  onHostFilterChange: (value: string) => void;
  hosts: Host[];
  filteredHosts: Host[];
  selectedHostIDs: string[];
  onToggleHostSelection: (hostID: string) => void;
  opsHostBusyID: string;
  onProbeHost: (host: Host) => Promise<void>;
  onStartEditHost: (host: Host) => void;
  onDeleteHost: (host: Host) => Promise<void>;
  selectedRuntime: string;
  onSelectedRuntimeChange: (value: string) => void;
  runtimes: RuntimeInfo[];
  runSandbox: "" | "read-only" | "workspace-write" | "danger-full-access";
  onRunSandboxChange: (
    value: "" | "read-only" | "workspace-write" | "danger-full-access",
  ) => void;
  runAsyncMode: boolean;
  onRunAsyncModeChange: (value: boolean) => void;
  metrics: MetricsResponse | null;
  onRefreshWorkspace: () => Promise<void>;
  isRefreshing: boolean;
  activeJob: RunJobRecord | null;
  onCancelJob: (job: RunJobRecord) => Promise<void>;
  jobsLength: number;
  runsLength: number;
  threadsLength: number;
  opsNotice: string;
  opsNoticeIsError: boolean;
};

export function OpsControlSidebar({
  health,
  allHosts,
  onAllHostsChange,
  selectedHostCount,
  hostFilter,
  onHostFilterChange,
  hosts,
  filteredHosts,
  selectedHostIDs,
  onToggleHostSelection,
  opsHostBusyID,
  onProbeHost,
  onStartEditHost,
  onDeleteHost,
  selectedRuntime,
  onSelectedRuntimeChange,
  runtimes,
  runSandbox,
  onRunSandboxChange,
  runAsyncMode,
  onRunAsyncModeChange,
  metrics,
  onRefreshWorkspace,
  isRefreshing,
  activeJob,
  onCancelJob,
  jobsLength,
  runsLength,
  threadsLength,
  opsNotice,
  opsNoticeIsError,
}: OpsControlSidebarProps) {
  return (
    <aside className="nav-pane">
      <header className="pane-head">
        <p className="pane-eyebrow">remote operations</p>
        <h2>Hosts and Runtime Control</h2>
        <p className="pane-subtle">health: {health}</p>
      </header>

      <section className="pane-block">
        <div className="pane-title-line">
          <h3>Targets</h3>
          <label className="switch-inline">
            <input
              type="checkbox"
              checked={allHosts}
              onChange={(event) => onAllHostsChange(event.target.checked)}
            />
            all
          </label>
        </div>
        <p className="pane-subtle">selected={selectedHostCount}</p>
        <label>
          filter
          <input
            placeholder="name / host / user / workspace"
            value={hostFilter}
            onChange={(event) => onHostFilterChange(event.target.value)}
          />
        </label>
        <div className="target-list">
          {hosts.length === 0 ? (
            <p className="pane-subtle">No hosts configured.</p>
          ) : filteredHosts.length === 0 ? (
            <p className="pane-subtle">No hosts match filter.</p>
          ) : (
            filteredHosts.map((host) => (
              <div key={host.id} className="target-item">
                <label className="target-checkline">
                  <input
                    type="checkbox"
                    disabled={allHosts}
                    checked={allHosts || selectedHostIDs.includes(host.id)}
                    onChange={() => onToggleHostSelection(host.id)}
                  />
                  <span className="target-meta">
                    <strong>{host.name}</strong>
                    <small>
                      {host.user ? `${host.user}@` : ""}
                      {host.host}:{host.port}
                      {` mode=${host.connection_mode ?? "ssh"}`}
                    </small>
                  </span>
                </label>
                <div className="target-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={opsHostBusyID === host.id}
                    onClick={() => void onProbeHost(host)}
                  >
                    {opsHostBusyID === host.id ? "..." : "Probe"}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={opsHostBusyID === host.id}
                    onClick={() => onStartEditHost(host)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ghost danger-ghost"
                    disabled={opsHostBusyID === host.id}
                    onClick={() => void onDeleteHost(host)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="pane-block">
        <h3>Runtime</h3>
        <label>
          runtime
          <select
            value={selectedRuntime}
            onChange={(event) => onSelectedRuntimeChange(event.target.value)}
          >
            {runtimes.map((runtime) => (
              <option key={runtime.name} value={runtime.name}>
                {runtime.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          sandbox
          <select
            value={runSandbox}
            onChange={(event) =>
              onRunSandboxChange(
                event.target.value as
                  | ""
                  | "read-only"
                  | "workspace-write"
                  | "danger-full-access",
              )
            }
          >
            <option value="">default</option>
            <option value="read-only">read-only</option>
            <option value="workspace-write">workspace-write</option>
            <option value="danger-full-access">danger-full-access</option>
          </select>
        </label>
        <label className="switch-inline">
          <input
            type="checkbox"
            checked={runAsyncMode}
            onChange={(event) => onRunAsyncModeChange(event.target.checked)}
          />
          async queue
        </label>
      </section>

      <section className="pane-block">
        <h3>Queue Control</h3>
        <ul className="metric-list">
          <li>pending={metrics?.jobs.pending ?? "-"}</li>
          <li>running={metrics?.jobs.running ?? "-"}</li>
          <li>depth={metrics?.queue.depth ?? "-"}</li>
        </ul>
        <div className="ops-actions-row">
          <button
            type="button"
            className="ghost"
            onClick={() => void onRefreshWorkspace()}
            disabled={isRefreshing}
          >
            {isRefreshing ? "Refreshing..." : "Refresh Queue"}
          </button>
          <button
            type="button"
            className="ghost danger-ghost"
            disabled={!activeJob || !isJobActive(activeJob)}
            onClick={() => (activeJob ? void onCancelJob(activeJob) : undefined)}
          >
            Cancel Active
          </button>
        </div>
      </section>

      <section className="pane-block">
        <h3>Overview</h3>
        <ul className="metric-list">
          <li>hosts={hosts.length}</li>
          <li>jobs={jobsLength}</li>
          <li>runs={runsLength}</li>
          <li>queue_depth={metrics?.queue.depth ?? "-"}</li>
          <li>
            workers={metrics?.queue.workers_active ?? "-"}/
            {metrics?.queue.workers_total ?? "-"}
          </li>
          <li>threads={threadsLength}</li>
        </ul>
      </section>

      {opsNotice ? (
        <section
          className={`pane-block ops-notice ${opsNoticeIsError ? "ops-notice-error" : ""}`}
        >
          <h3>Ops Notice</h3>
          <p>{opsNotice}</p>
        </section>
      ) : null}
    </aside>
  );
}
