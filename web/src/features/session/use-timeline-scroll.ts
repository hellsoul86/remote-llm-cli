import { useEffect, useRef, useState } from "react";

type UseTimelineScrollOptions = {
  activeThreadID: string;
  timelineLength: number;
  timelineTailID: string;
  timelineTailState: string;
  timelineTailBody: string;
  stickGapPx: number;
  jumpCountCap: number;
};

export function useTimelineScrollController({
  activeThreadID,
  timelineLength,
  timelineTailID,
  timelineTailState,
  timelineTailBody,
  stickGapPx,
  jumpCountCap,
}: UseTimelineScrollOptions) {
  const [timelineUnreadCount, setTimelineUnreadCount] = useState(0);
  const timelineViewportRef = useRef<HTMLElement | null>(null);
  const timelineBottomRef = useRef<HTMLDivElement | null>(null);
  const timelineStickToBottomRef = useRef(true);
  const timelineForceStickRef = useRef(false);
  const timelineLastSignatureRef = useRef("");
  const timelineLastCountRef = useRef(0);
  const timelineLastTailIDRef = useRef("");
  const timelineLastTailStateRef = useRef("");
  const lastTimelineThreadIDRef = useRef("");

  useEffect(() => {
    const node = timelineViewportRef.current;
    if (!node) return;
    const threadChanged = lastTimelineThreadIDRef.current !== activeThreadID;
    const nextSignature = [
      activeThreadID,
      String(timelineLength),
      timelineTailID,
      timelineTailState,
      String(timelineTailBody.length),
    ].join("|");
    const previousSignature = timelineLastSignatureRef.current;
    const previousCount = timelineLastCountRef.current;
    const previousTailID = timelineLastTailIDRef.current;
    const previousTailState = timelineLastTailStateRef.current;

    timelineLastCountRef.current = timelineLength;
    timelineLastTailIDRef.current = timelineTailID;
    timelineLastTailStateRef.current = timelineTailState;

    if (threadChanged) {
      lastTimelineThreadIDRef.current = activeThreadID;
      timelineForceStickRef.current = true;
      timelineLastSignatureRef.current = nextSignature;
      timelineLastCountRef.current = timelineLength;
      timelineLastTailIDRef.current = timelineTailID;
      timelineLastTailStateRef.current = timelineTailState;
      setTimelineUnreadCount(0);
    }

    const shouldStick =
      timelineForceStickRef.current ||
      timelineStickToBottomRef.current ||
      threadChanged;
    const timelineChanged = !threadChanged && previousSignature !== nextSignature;

    if (!shouldStick && timelineChanged) {
      const structuralChange =
        previousCount !== timelineLength ||
        previousTailID !== timelineTailID ||
        previousTailState !== timelineTailState;
      timelineLastSignatureRef.current = nextSignature;
      if (structuralChange) {
        setTimelineUnreadCount((count) =>
          Math.min(jumpCountCap, count + 1),
        );
      }
      return;
    }

    timelineLastSignatureRef.current = nextSignature;
    if (!shouldStick) return;

    const frame = window.requestAnimationFrame(() => {
      if (timelineBottomRef.current) {
        timelineBottomRef.current.scrollIntoView({ block: "end" });
      } else {
        node.scrollTop = node.scrollHeight;
      }
      timelineForceStickRef.current = false;
      setTimelineUnreadCount(0);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    activeThreadID,
    timelineLength,
    timelineTailBody,
    timelineTailID,
    timelineTailState,
    jumpCountCap,
  ]);

  function onTimelineScroll() {
    const node = timelineViewportRef.current;
    if (!node) return;
    const gap = Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop);
    const pinned = gap <= stickGapPx;
    timelineStickToBottomRef.current = pinned;
    if (pinned) {
      setTimelineUnreadCount(0);
    }
  }

  function jumpTimelineToLatest() {
    const node = timelineViewportRef.current;
    if (!node) return;
    timelineForceStickRef.current = true;
    timelineStickToBottomRef.current = true;
    setTimelineUnreadCount(0);
    if (timelineBottomRef.current) {
      timelineBottomRef.current.scrollIntoView({ block: "end" });
      return;
    }
    node.scrollTop = node.scrollHeight;
  }

  function forceStickToBottom() {
    timelineForceStickRef.current = true;
    timelineStickToBottomRef.current = true;
    setTimelineUnreadCount(0);
  }

  return {
    timelineUnreadCount,
    timelineViewportRef,
    timelineBottomRef,
    onTimelineScroll,
    jumpTimelineToLatest,
    forceStickToBottom,
  };
}
