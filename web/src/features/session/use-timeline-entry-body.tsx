import { useEffect, useRef, useState } from "react";

import type { TimelineEntry } from "../../domains/session";
import {
  parseMessageSegments,
  shouldCollapseMessageBody,
} from "./view-helpers";

type UseTimelineEntryBodyOptions = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  activeThreadBusy: boolean;
  onEditAndResend: (entry: TimelineEntry) => Promise<void>;
};

export function useTimelineEntryBody(options: UseTimelineEntryBodyOptions) {
  const [expandedMessageIDs, setExpandedMessageIDs] = useState<string[]>([]);
  const [copiedCodeKey, setCopiedCodeKey] = useState("");
  const copyResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const toggleMessageExpanded = (entryID: string) => {
    setExpandedMessageIDs((prev) =>
      prev.includes(entryID)
        ? prev.filter((id) => id !== entryID)
        : [...prev, entryID],
    );
  };

  const copyToClipboard = async (content: string, key: string) => {
    const text = content ?? "";
    if (!text) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.focus();
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setCopiedCodeKey(key);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedCodeKey("");
      }, 1500);
    } catch {
      setCopiedCodeKey("");
    }
  };

  const renderTimelineEntryBody = (entry: TimelineEntry) => {
    const segments = parseMessageSegments(entry.body);
    const collapsible = shouldCollapseMessageBody(entry.body);
    const expanded = expandedMessageIDs.includes(entry.id);
    const showCollapsed = collapsible && !expanded;
    const wrapperClass = `message-body${showCollapsed ? " message-body-collapsed" : ""}`;
    const canEditAndResend =
      entry.kind === "user" &&
      options.authPhase === "ready" &&
      options.token.trim() !== "";
    return (
      <div className={wrapperClass}>
        {segments.map((segment, index) =>
          segment.kind === "text" ? (
            <pre key={`${entry.id}_text_${index}`}>{segment.content}</pre>
          ) : (
            <section key={`${entry.id}_code_${index}`} className="message-code-block">
              <header className="message-code-head">
                <span>{segment.lang || "code"}</span>
                <button
                  type="button"
                  className="ghost code-copy-btn"
                  onClick={() => void copyToClipboard(segment.content, `${entry.id}_${index}`)}
                >
                  {copiedCodeKey === `${entry.id}_${index}` ? "Copied" : "Copy"}
                </button>
              </header>
              <pre className="message-code-pre">{segment.content}</pre>
            </section>
          ),
        )}
        {showCollapsed ? <div className="message-collapse-mask" aria-hidden="true" /> : null}
        {collapsible ? (
          <div className="message-collapse-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => toggleMessageExpanded(entry.id)}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          </div>
        ) : null}
        {canEditAndResend ? (
          <div className="message-user-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => void options.onEditAndResend(entry)}
              disabled={options.activeThreadBusy}
            >
              Edit & Resend
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  return {
    renderTimelineEntryBody,
  };
}
