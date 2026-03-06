import type { AuditEvent } from "../../../api";

type OpsAuditTimelinePanelProps = {
  opsAuditMethodFilter: "all" | "GET" | "POST" | "DELETE";
  onOpsAuditMethodFilterChange: (
    value: "all" | "GET" | "POST" | "DELETE",
  ) => void;
  opsAuditStatusFilter: "all" | "2xx" | "4xx" | "5xx";
  onOpsAuditStatusFilterChange: (
    value: "all" | "2xx" | "4xx" | "5xx",
  ) => void;
  filteredAuditEvents: AuditEvent[];
};

export function OpsAuditTimelinePanel({
  opsAuditMethodFilter,
  onOpsAuditMethodFilterChange,
  opsAuditStatusFilter,
  onOpsAuditStatusFilterChange,
  filteredAuditEvents,
}: OpsAuditTimelinePanelProps) {
  return (
    <section className="inspect-block">
      <h3>Audit Timeline</h3>
      <div className="ops-filter-row">
        <label>
          method
          <select
            value={opsAuditMethodFilter}
            onChange={(event) =>
              onOpsAuditMethodFilterChange(
                event.target.value as "all" | "GET" | "POST" | "DELETE",
              )
            }
          >
            <option value="all">all</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="DELETE">DELETE</option>
          </select>
        </label>
        <label>
          status
          <select
            value={opsAuditStatusFilter}
            onChange={(event) =>
              onOpsAuditStatusFilterChange(
                event.target.value as "all" | "2xx" | "4xx" | "5xx",
              )
            }
          >
            <option value="all">all</option>
            <option value="2xx">2xx</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
          </select>
        </label>
      </div>
      {filteredAuditEvents.length === 0 ? (
        <p className="pane-subtle-light">
          No audit events with current filters.
        </p>
      ) : (
        <ul className="history-list">
          {filteredAuditEvents.slice(0, 12).map((evt) => (
            <li key={evt.id}>
              <div className="history-item-main">
                <span>{evt.action}</span>
                <span>
                  {evt.method} {evt.path}
                </span>
              </div>
              <span
                className={`tone-${evt.status_code < 400 ? "ok" : "err"}`}
              >
                {evt.status_code}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
