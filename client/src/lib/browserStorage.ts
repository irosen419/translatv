// The one guarded way into localStorage.
//
// Storage is not reliably there. Safari in private browsing throws on setItem, an embedded
// webview can have it disabled outright, a user can block site data, and in the node environment
// the client suite runs in there is no `window` at all. None of those is an error worth showing
// anyone: every one of them means "this preference will not survive a reload", which every
// caller here already handles.
//
// It lives on its own rather than inside the first module that needed it, because the second
// module that needs it must not reach for `window.localStorage` again. Two copies of a guard are
// two chances for one of them to be the unguarded one.

/** The slice of Storage this app uses. An interface so a test can hand it something that throws. */
export interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The browser's localStorage, or null when it cannot be used.
 *
 * Probed rather than assumed: merely READING the property throws in some configurations, so a
 * bare `window.localStorage` reference is itself the thing that can break the page. The
 * `typeof` check is the node case, where `window` is not defined at all and a bare reference is
 * a ReferenceError at module scope.
 */
export function browserStorage(): WebStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
