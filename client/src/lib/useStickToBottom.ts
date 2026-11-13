// Keep a growing log scrolled to its newest line, unless the reader has scrolled up to read.
//
// Whether to follow is decided by where the reader WAS, recorded on every scroll, not by
// measuring after the new content has rendered. The measure after approach (the transcript and
// the overlay both had it) treats "the new line is taller than the slack" as "the reader scrolled
// away", so a long sentence with its translation under it silently ended the following, and every
// line after it arrived out of sight.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * How close to the bottom still counts as at the bottom, in pixels. Small on purpose: it only
 * absorbs subpixel rounding and a reader who stopped a few pixels short, because it is no longer
 * asked to cover the height of whatever just arrived.
 */
export const PIN_SLACK_PX = 24;

export interface StickToBottom<T extends HTMLElement> {
  ref: React.RefObject<T>;
  /** Attach to the scroller's onScroll, so a reader scrolling up stops the following. */
  onScroll(): void;
  /** Scroll to the newest line if following. With force, start following again first. */
  pin(force?: boolean): void;
}

/** @param content Anything that changes when the log does: its lines, an interim caption. */
export function useStickToBottom<T extends HTMLElement>(...content: unknown[]): StickToBottom<T> {
  const ref = useRef<T>(null);
  const following = useRef(true);

  const onScroll = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= PIN_SLACK_PX;
  }, []);

  const pin = useCallback((force = false) => {
    const node = ref.current;
    if (!node) return;
    if (force) following.current = true;
    if (following.current) node.scrollTop = node.scrollHeight;
  }, []);

  // Before paint, so a new line never flashes in below the fold and then jumps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => pin(), [pin, ...content]);

  // The box can shrink with no new line and no scroll event (the composer under it grows, a
  // phone's keyboard opens), which leaves a following reader short of the bottom. Re-pin on resize.
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => pin());
    observer.observe(node);
    return () => observer.disconnect();
  }, [pin]);

  return { ref, onScroll, pin };
}
