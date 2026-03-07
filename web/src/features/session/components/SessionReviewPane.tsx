import { useEffect, useState } from "react";

import type { CodexSessionMode, TimelineState } from "../../../domains/session";

type ReviewFinding = {
  id: string;
  title: string;
  body: string;
  timestamp: string;
  tone: "assistant" | "system";
};

type ReviewChange = {
  id: string;
  path: string;
  kind: string;
  state: TimelineState;
  title: string;
  summary: string;
  timestamp: string;
};

type SessionReviewPaneProps = {
  mode: CodexSessionMode;
  busy: boolean;
  reviewUncommitted: boolean;
  reviewBase: string;
  reviewCommit: string;
  reviewTitle: string;
  changes: ReviewChange[];
  findings: ReviewFinding[];
  onClose: () => void;
  onSetMode: (mode: CodexSessionMode) => void;
  onSetReviewUncommitted: (next: boolean) => void;
  onSetReviewBase: (value: string) => void;
  onSetReviewCommit: (value: string) => void;
  onSetReviewTitle: (value: string) => void;
};

export function SessionReviewPane({
  mode,
  busy,
  reviewUncommitted,
  reviewBase,
  reviewCommit,
  reviewTitle,
  changes,
  findings,
  onClose,
  onSetMode,
  onSetReviewUncommitted,
  onSetReviewBase,
  onSetReviewCommit,
  onSetReviewTitle,
}: SessionReviewPaneProps) {
  const reviewActive = mode === "review";
  const [selectedChangeID, setSelectedChangeID] = useState("");

  useEffect(() => {
    if (changes.length === 0) {
      setSelectedChangeID("");
      return;
    }
    if (!changes.some((change) => change.id === selectedChangeID)) {
      setSelectedChangeID(changes[0]?.id ?? "");
    }
  }, [changes, selectedChangeID]);

  const selectedChange =
    changes.find((change) => change.id === selectedChangeID) ?? changes[0] ?? null;

  return (
    <aside className="review-pane" data-testid="review-pane">
      <div className="review-pane-head">
        <div>
          <p className="review-pane-eyebrow">Thread tools</p>
          <h3>Review</h3>
        </div>
        <button
          type="button"
          className="ghost review-close-btn"
          data-testid="review-pane-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <div className="review-mode-switch" data-testid="review-mode-switch">
        <button
          type="button"
          className={reviewActive ? "ghost review-mode-btn" : "ghost review-mode-btn active"}
          aria-pressed={!reviewActive}
          data-testid="review-mode-exec"
          onClick={() => onSetMode("exec")}
          disabled={busy}
        >
          Exec
        </button>
        <button
          type="button"
          className={reviewActive ? "ghost review-mode-btn active" : "ghost review-mode-btn"}
          aria-pressed={reviewActive}
          data-testid="review-mode-review"
          onClick={() => onSetMode("review")}
          disabled={busy}
        >
          Review
        </button>
      </div>

      <section className="review-pane-block">
        <div className="review-pane-copy">
          <strong>Review setup</strong>
          <p>
            Keep review scope and findings in a side pane so the main thread stays
            focused on the conversation.
          </p>
        </div>
        <label className="review-toggle-row">
          <span>Review uncommitted changes</span>
          <input
            type="checkbox"
            data-testid="review-uncommitted-toggle"
            checked={reviewUncommitted}
            disabled={busy || !reviewActive}
            onChange={(event) => onSetReviewUncommitted(event.target.checked)}
          />
        </label>
        <label className="review-field">
          <span>Base branch</span>
          <input
            data-testid="review-base-input"
            placeholder="main"
            value={reviewBase}
            disabled={busy || !reviewActive}
            onChange={(event) => onSetReviewBase(event.target.value)}
          />
        </label>
        <label className="review-field">
          <span>Commit</span>
          <input
            data-testid="review-commit-input"
            placeholder="HEAD~1"
            value={reviewCommit}
            disabled={busy || !reviewActive}
            onChange={(event) => onSetReviewCommit(event.target.value)}
          />
        </label>
        <label className="review-field">
          <span>Title</span>
          <input
            data-testid="review-title-input"
            placeholder="Repository review"
            value={reviewTitle}
            disabled={busy || !reviewActive}
            onChange={(event) => onSetReviewTitle(event.target.value)}
          />
        </label>
      </section>

      <section className="review-pane-block review-changes-block">
        <div className="review-pane-copy">
          <strong>Changed files</strong>
          <p>
            Review-relevant file changes stay here instead of interrupting the
            conversation timeline.
          </p>
        </div>
        {changes.length === 0 ? (
          <p className="review-empty-copy" data-testid="review-change-empty">
            File changes from Codex will appear here when review or patch events
            are reported.
          </p>
        ) : (
          <div className="review-change-shell">
            <div className="review-change-list" data-testid="review-change-list">
              {changes.map((change) => {
                const active = selectedChange?.id === change.id;
                return (
                  <button
                    key={change.id}
                    type="button"
                    className={`ghost review-change-item${
                      active ? " active" : ""
                    } review-change-${change.state}`}
                    data-testid="review-change-item"
                    onClick={() => setSelectedChangeID(change.id)}
                  >
                    <span className="review-change-kind">{change.kind}</span>
                    <strong>{change.path}</strong>
                    <small>{change.title}</small>
                  </button>
                );
              })}
            </div>
            {selectedChange ? (
              <article className="review-change-detail" data-testid="review-change-detail">
                <header>
                  <div>
                    <p className="review-change-kindline">
                      {selectedChange.kind} file
                    </p>
                    <h4>{selectedChange.path}</h4>
                  </div>
                  <time>{selectedChange.timestamp}</time>
                </header>
                <p className="review-change-summary-title">{selectedChange.title}</p>
                <pre>{selectedChange.summary}</pre>
              </article>
            ) : null}
          </div>
        )}
      </section>

      <section className="review-pane-block review-findings-block">
        <div className="review-pane-copy">
          <strong>Latest findings</strong>
          <p>
            Recent assistant and system messages are mirrored here until true diff
            comments land.
          </p>
        </div>
        {findings.length === 0 ? (
          <p className="review-empty-copy" data-testid="review-empty-copy">
            Switch to review mode, describe what to inspect, and send from the composer.
          </p>
        ) : (
          <div className="review-finding-list" data-testid="review-findings">
            {findings.map((finding) => (
              <article key={finding.id} className={`review-finding-card review-finding-${finding.tone}`}>
                <header>
                  <strong>{finding.title}</strong>
                  <time>{finding.timestamp}</time>
                </header>
                <pre>{finding.body}</pre>
              </article>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
