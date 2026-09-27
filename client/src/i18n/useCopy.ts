// The React side of the copy lookup.
//
// Reads ONE field from the store, the dialect the interface is in. That is what makes switching
// dialect mid call repaint every word on screen: zustand notifies every component subscribed to
// uiDialect, copyFor hands back a different object for the new dialect, and the whole interface
// re-renders in the new language in the same tick the picker moves. There is no separate UI
// language setting to keep in step, by owner decision: the language you chose to SPEAK is the
// language you read the app in.

import { useStore } from "../state/store.js";
import { copyFor, type Copy } from "./copy.js";

export function useCopy(): Copy {
  // copyFor memoizes per dialect, so this is a map lookup per render rather than a rebuild, and
  // the identity is stable enough to sit in a dependency array.
  return useStore((state) => copyFor(state.uiDialect));
}
