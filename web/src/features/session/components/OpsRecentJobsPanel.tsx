import type { RunJobRecord } from "../../../api";
import { isJobActive } from "../runtime-utils";
import { statusTone } from "../view-helpers";

type OpsRecentJobsPanelProps = {
  opsJobStatusFilter:
    | "all"
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "canceled";
  onOpsJobStatusFilterChange: (
    value:
      | "all"
      | "pending"
      | "running"
      | "succeeded"
      | "failed"
      | "canceled",
  ) => void;
  opsJobTypeFilter: "all" | "run" | "sync";
  onOpsJobTypeFilterChange: (value: "all" | "run" | "sync") => void;
  filteredOpsJobs: RunJobRecord[];
  onSelectActiveJob: (job: RunJobRecord) => void;
  onCancelJob: (job: RunJobRecord) => Promise<void>;
};

export function OpsRecentJobsPanel({
  opsJobStatusFilter,
  onOpsJobStatusFilterChange,
  opsJobTypeFilter,
  onOpsJobTypeFilterChange,
  filteredOpsJobs,
  onSelectActiveJob,
  onCancelJob,
}: OpsRecentJobsPanelProps) {
  return (
    <section className="inspect-block">
      <h3>Recent Jobs</h3>
      <div className="ops-filter-row">
        <label>
          status
          <select
            value={opsJobStatusFilter}
            onChange={(event) =>
              onOpsJobStatusFilterChange(
                event.target.value as
                  | "all"
                  | "pending"
                  | "running"
                  | "succeeded"
                  | "failed"
                  | "canceled",
              )
            }
          >
            <option value="all">all</option>
            <option value="pending">pending</option>
            <option value="running">running</option>
            <option value="succeeded">succeeded</option>
            <option value="failed">failed</option>
            <option value="canceled">canceled</option>
          </select>
        </label>
        <label>
          type
          <select
            value={opsJobTypeFilter}
            onChange={(event) =>
              onOpsJobTypeFilterChange(
                event.target.value as "all" | "run" | "sync",
              )
            }
          >
            <option value="all">all</option>
            <option value="run">run</option>
            <option value="sync">sync</option>
          </select>
        </label>
      </div>
      {filteredOpsJobs.length === 0 ? (
        <p className="pane-subtle-light">No jobs yet.</p>
      ) : (
        <ul className="history-list">
          {filteredOpsJobs.slice(0, 8).map((job) => (
            <li key={job.id}>
              <div className="history-item-main">
                <button
                  className="ghost"
                  onClick={() => onSelectActiveJob(job)}
                >
                  {job.id}
                </button>
                <span className={`tone-${statusTone(job.status)}`}>
                  {job.status}
                </span>
                <span>{job.type}</span>
              </div>
              <div className="history-item-actions">
                {isJobActive(job) ? (
                  <button
                    type="button"
                    className="ghost danger-ghost"
                    onClick={() => void onCancelJob(job)}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
