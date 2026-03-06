import type { RunJobRecord } from "../../../api";
import { formatDateTime } from "../runtime-utils";
import { statusTone } from "../view-helpers";

type OpsActiveJobPanelProps = {
  activeJob: RunJobRecord | null;
  activeJobThreadID: string;
  activeProgress: number;
};

export function OpsActiveJobPanel({
  activeJob,
  activeJobThreadID,
  activeProgress,
}: OpsActiveJobPanelProps) {
  return (
    <section className="inspect-block">
      <h3>Active Job</h3>
      {activeJob ? (
        <div className="job-card">
          <div className="job-head">
            <strong>{activeJob.id}</strong>
            <span className={`tone-${statusTone(activeJob.status)}`}>
              {activeJob.status}
            </span>
          </div>
          <p>runtime={activeJob.runtime}</p>
          <p>thread={activeJobThreadID}</p>
          <p>queued={formatDateTime(activeJob.queued_at)}</p>
          <p>
            hosts total={activeJob.total_hosts ?? 0} ok=
            {activeJob.succeeded_hosts ?? 0} failed=
            {activeJob.failed_hosts ?? 0}
          </p>
          <div className="progress-track" aria-label="job progress">
            <span style={{ width: `${activeProgress}%` }} />
          </div>
          <p>http={activeJob.result_status ?? "n/a"}</p>
          {activeJob.error ? (
            <p className="tone-err">{activeJob.error}</p>
          ) : null}
        </div>
      ) : (
        <p className="pane-subtle-light">No active async job.</p>
      )}
    </section>
  );
}
