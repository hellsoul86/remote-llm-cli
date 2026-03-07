import { useEffect, useMemo, useState } from "react";

import type { CodexSessionMode, TimelineState } from "../../../domains/session";

type ReviewFinding = {
  id: string;
  title: string;
  body: string;
  timestamp: string;
  tone: "assistant" | "system";
};

type ReviewNote = ReviewFinding;

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

function pathTokens(path: string): string[] {
  const normalized = path.trim().toLowerCase();
  if (!normalized) return [];
  const basename = normalized.split("/").filter(Boolean).at(-1) ?? "";
  return Array.from(
    new Set(
      [normalized, basename].filter((value) => value.trim().length >= 5),
    ),
  );
}

function findingMatchesChange(finding: ReviewFinding, change: ReviewChange): boolean {
  const haystack = `${finding.title}\n${finding.body}`.toLowerCase();
  return pathTokens(change.path).some((token) => haystack.includes(token));
}

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
  const [dismissedNoteIDs, setDismissedNoteIDs] = useState<string[]>([]);
  const [reviewedChangeIDs, setReviewedChangeIDs] = useState<string[]>([]);

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

  useEffect(() => {
    setDismissedNoteIDs((current) =>
      current.filter((id) =>
        findings.some((finding) => id === finding.id || id.startsWith(`${finding.id}:`)),
      ),
    );
  }, [findings]);

  useEffect(() => {
    setReviewedChangeIDs((current) =>
      current.filter((id) => changes.some((change) => change.id === id)),
    );
  }, [changes]);

  const reviewNotes = useMemo(
    () =>
      findings.flatMap((finding) => {
        const segments = finding.body
          .split(/\n\s*\n/g)
          .map((segment) => segment.trim())
          .filter((segment) => segment !== "");
        if (segments.length <= 1) {
          return [finding];
        }
        return segments.map((segment, index) => ({
          ...finding,
          id: `${finding.id}:${index}`,
          body: segment,
        }));
      }),
    [findings],
  );

  const visibleNotes = useMemo(
    () =>
      reviewNotes.filter((note) => !dismissedNoteIDs.includes(note.id)),
    [dismissedNoteIDs, reviewNotes],
  );

  const findingsByChangeID = useMemo(() => {
    const map = new Map<string, ReviewNote[]>();
    for (const change of changes) {
      const related = visibleNotes.filter((note) =>
        findingMatchesChange(note, change),
      );
      map.set(change.id, related);
    }
    return map;
  }, [changes, visibleNotes]);

  const selectedChangeFindings = selectedChange
    ? findingsByChangeID.get(selectedChange.id) ?? []
    : [];
  const generalFindings = visibleNotes.filter(
    (note) =>
      !changes.some((change) => findingMatchesChange(note, change)),
  );
  const selectedChangeReviewed =
    selectedChange !== null && reviewedChangeIDs.includes(selectedChange.id);
  const reviewedChangeCount = reviewedChangeIDs.length;

  const dismissFinding = (findingID: string) => {
    setDismissedNoteIDs((current) =>
      current.includes(findingID) ? current : [...current, findingID],
    );
  };

  const toggleSelectedChangeReviewed = () => {
    if (!selectedChange) return;
    setReviewedChangeIDs((current) =>
      current.includes(selectedChange.id)
        ? current.filter((id) => id !== selectedChange.id)
        : [...current, selectedChange.id],
    );
  };

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

      <div className="review-pane-metrics" data-testid="review-pane-metrics">
        <span>{changes.length} files</span>
        <span>{visibleNotes.length} notes</span>
        <span>{reviewedChangeCount} reviewed</span>
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

      <section className="review-pane-block review-changes-block">
        <div className="review-pane-copy">
          <strong>Changed files</strong>
          <p>
            Keep file navigation and review notes here instead of interrupting the
            conversation.
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
                    <div className="review-change-item-meta">
                      <span className="review-change-kind">{change.kind}</span>
                      {reviewedChangeIDs.includes(change.id) ? (
                        <span className="review-change-badge review-change-reviewed">
                          Reviewed
                        </span>
                      ) : null}
                      {(findingsByChangeID.get(change.id)?.length ?? 0) > 0 ? (
                        <span className="review-change-badge">
                          {findingsByChangeID.get(change.id)?.length} notes
                        </span>
                      ) : null}
                    </div>
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
                  <div className="review-change-detail-side">
                    <time>{selectedChange.timestamp}</time>
                    <button
                      type="button"
                      className={`ghost review-inline-action${
                        selectedChangeReviewed ? " active" : ""
                      }`}
                      data-testid="review-change-mark-reviewed"
                      onClick={toggleSelectedChangeReviewed}
                    >
                      {selectedChangeReviewed ? "Reviewed" : "Mark reviewed"}
                    </button>
                  </div>
                </header>
                <div className="review-change-detail-meta">
                  <span>{selectedChange.title}</span>
                  <span>{selectedChangeFindings.length} linked notes</span>
                </div>
                <p className="review-change-summary-title">{selectedChange.title}</p>
                <pre>{selectedChange.summary}</pre>
                <div className="review-inline-thread">
                  <div className="review-subsection-head">
                    <strong>Discussion</strong>
                    <span>{selectedChangeFindings.length}</span>
                  </div>
                  {selectedChangeFindings.length === 0 ? (
                    <p
                      className="review-empty-copy"
                      data-testid="review-file-findings-empty"
                    >
                      File-linked review notes will stack here when Codex calls out
                      this file directly.
                    </p>
                  ) : (
                    <div
                      className="review-finding-list"
                      data-testid="review-file-findings"
                    >
                      {selectedChangeFindings.map((finding) => (
                        <article
                          key={finding.id}
                          className={`review-finding-card review-finding-${finding.tone}`}
                        >
                          <header>
                            <div>
                              <strong>{finding.title}</strong>
                              <time>{finding.timestamp}</time>
                            </div>
                            <button
                              type="button"
                              className="ghost review-inline-action"
                              data-testid="review-finding-dismiss"
                              onClick={() => dismissFinding(finding.id)}
                            >
                              Dismiss
                            </button>
                          </header>
                          <pre>{finding.body}</pre>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            ) : null}
          </div>
        )}
      </section>

      <section className="review-pane-block review-findings-block">
        <div className="review-pane-copy">
          <strong>General notes</strong>
          <p>
            Keep non-file-specific notes here so the review surface stays useful
            without polluting the thread.
          </p>
        </div>
        {dismissedNoteIDs.length > 0 ? (
          <button
            type="button"
            className="ghost review-inline-action review-restore-btn"
            data-testid="review-restore-dismissed"
            onClick={() => setDismissedNoteIDs([])}
          >
            Restore {dismissedNoteIDs.length} dismissed note
            {dismissedNoteIDs.length === 1 ? "" : "s"}
          </button>
        ) : null}
        {generalFindings.length === 0 ? (
          <p className="review-empty-copy" data-testid="review-empty-copy">
            Switch to review mode, describe what to inspect, and send from the composer.
          </p>
        ) : (
          <div className="review-finding-list" data-testid="review-findings">
            {generalFindings.map((finding) => (
              <article key={finding.id} className={`review-finding-card review-finding-${finding.tone}`}>
                <header>
                  <div>
                    <strong>{finding.title}</strong>
                    <time>{finding.timestamp}</time>
                  </div>
                  <button
                    type="button"
                    className="ghost review-inline-action"
                    data-testid="review-finding-dismiss"
                    onClick={() => dismissFinding(finding.id)}
                  >
                    Dismiss
                  </button>
                </header>
                <pre>{finding.body}</pre>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="review-pane-block review-setup-block">
        <div className="review-pane-copy">
          <strong>Review scope</strong>
          <p>
            Keep scope controls available, but secondary to files and notes.
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
    </aside>
  );
}
