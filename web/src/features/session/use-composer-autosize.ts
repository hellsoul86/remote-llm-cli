import { type MutableRefObject, useEffect } from "react";

type UseComposerAutoResizeOptions = {
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  value: string;
  activeThreadID: string;
  minHeight: number;
  maxHeight: number;
};

export function useComposerAutoResize({
  inputRef,
  value,
  activeThreadID,
  minHeight,
  maxHeight,
}: UseComposerAutoResizeOptions) {
  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "0px";
    const nextHeight = Math.max(minHeight, Math.min(maxHeight, node.scrollHeight));
    node.style.height = `${nextHeight}px`;
  }, [activeThreadID, maxHeight, minHeight, inputRef, value]);
}
