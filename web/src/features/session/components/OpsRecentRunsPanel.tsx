import type { RunRecord } from "../../../api";

type OpsRecentRunsPanelProps = {
  opsRunStatusFilter: "all" | "ok" | "error";
  onOpsRunStatusFilterChange: (value: "all" | "ok" | "error") => void;
  filteredOpsRuns: RunRecord[];
};

export function OpsRecentRunsPanel({
  opsRunStatusFilter,
  onOpsRunStatusFilterChange,
  filteredOpsRuns,
}: OpsRecentRunsPanelProps) {
  return (
    <section className="inspect-block">
      <h3>Recent Runs</h3>
      <div className="ops-filter-row">
        <label>
          status
          <select
            value={opsRunStatusFilter}
            onChange={(event) =>
              onOpsRunStatusFilterChange(
                event.target.value as "all" | "ok" | "error",
              )
            }
          >
            <option value="all">all</option>
            <option value="ok">ok</option>
            <option value="error">error</option>
          </select>
        </label>
      </div>
      {filteredOpsRuns.length === 0 ? (
        <p className="pane-subtle-light">No run results yet.</p>
      ) : (
        <ul className="history-list history-runs">
          {filteredOpsRuns.slice(0, 8).map((run) => (
            <li key={run.id}>
              <span>{run.id}</span>
              <span
                className={`tone-${run.status_code < 400 ? "ok" : "err"}`}
              >
                {run.status_code < 400 ? "ok" : `http_${run.status_code}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
