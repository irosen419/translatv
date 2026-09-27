import { useEffect, useState } from "react";

/**
 * The one breakpoint the layout switches at.
 *
 * Exported so the media queries in styles.css and the component swap in Room.tsx are the same
 * number in one place. When they were two numbers they were free to disagree, and the failure
 * that produces is a narrow band of widths showing the mobile overlay and the desktop panel at
 * once, both claiming the bottom of the screen.
 */
export const NARROW_QUERY = "(max-width: 860px)";

/** Track a media query, re-rendering when it flips. */
export function useMediaQuery(query: string): boolean {
  // Read synchronously for the first paint. Starting false and correcting in an effect would
  // mount the desktop tree on a phone and then throw it away, which on this screen means the
  // video element is created twice.
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (!list) return;
    const onChange = () => setMatches(list.matches);
    // Re-read on subscribe: the query can have flipped between the first render and here, and
    // that change event is already gone.
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
