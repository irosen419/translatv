// Where the admin token lives between page loads.
//
// localStorage rather than sessionStorage, by owner decision: this app already restores a call
// after a reload, and being logged out by a refresh in the middle of your own room would fight
// that. The token is a bearer credential, so it is treated as one: read it, send it, never log
// it, and drop it the moment the server says it is no longer good.
//
// Every access is wrapped, because storage is not reliably there. Safari in private mode throws
// on setItem, an embedded webview can have it disabled outright, and a user can block site data.
// None of those are errors worth showing anyone: they mean "you will have to log in again",
// which the app handles already.

/** The slice of Storage this needs. An interface so a test can hand it something that throws. */
export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const TOKEN_KEY = "translatv.adminToken";

/**
 * The browser's localStorage, or null when it cannot be used.
 *
 * Probed rather than assumed: merely READING the property throws in some configurations, so
 * a bare `window.localStorage` reference is itself the thing that can break the page.
 */
export function browserStore(): TokenStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The stored token, or null.
 *
 * An empty string is null. A cleared key can read back as "" rather than absent, and an empty
 * token is not a credential: sending it would produce a refusal that looks like a wrong
 * password rather than like no login at all.
 */
export function readToken(store: TokenStore | null): string | null {
  if (!store) return null;
  try {
    const value = store.getItem(TOKEN_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeToken(store: TokenStore | null, token: string): void {
  if (!store) return;
  try {
    store.setItem(TOKEN_KEY, token);
  } catch {
    // Nothing to do and nothing to say. The token still works for this page's lifetime; it
    // just will not survive a reload.
  }
}

export function clearToken(store: TokenStore | null): void {
  if (!store) return;
  try {
    store.removeItem(TOKEN_KEY);
  } catch {
    // Same as above. Worth noting the asymmetry: a clear that fails leaves a credential behind,
    // so callers must also drop it from memory rather than trusting this to have worked.
  }
}
