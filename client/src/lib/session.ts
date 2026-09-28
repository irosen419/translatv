// The signed in session: who this browser is, and a valid access token when something needs one.
//
// Two tokens, kept in two different places on purpose:
//
//   access   15 minutes, IN MEMORY ONLY. Sent on the WebSocket upgrade and on /api calls. Losing
//            it costs nothing: a reload just refreshes for a new one.
//   refresh  30 days, in localStorage under "translatv.refresh", so a reload (which this app
//            already survives mid call) does not sign anyone out. The server rotates it on every
//            use and revokes the whole chain if a spent one is ever presented again.
//
// localStorage is readable by any script on this origin, so an XSS bug would leak the refresh
// token. That is the SAME exposure the retired admin token had (it lived in localStorage too),
// and the strict CSP (no inline or third party script) is what stands in front of it. The
// follow up is an httpOnly, SameSite=Strict cookie scoped to /api/auth/refresh, which script
// cannot read at all; it needs the refresh endpoint to accept a cookie and a CSRF story for it,
// so it is a separate change rather than a quiet part of this one.
//
// The refresh token is a bearer credential and is treated as one: never logged, never put in a
// URL, dropped from storage the moment the server says it is no longer good.

import type { AuthErrorCode, AuthSession, PublicUser } from "@translatv/shared";

/** Where the refresh token lives between page loads. */
export const REFRESH_KEY = "translatv.refresh";

/** Refresh this long before the access token expires, so a request never races the expiry. */
export const REFRESH_MARGIN_MS = 60_000;

/** The slice of Storage this needs. An interface so a test can hand it something that throws. */
export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The browser's localStorage, or null when it cannot be used.
 *
 * Probed rather than assumed: merely READING the property throws in some configurations (Safari
 * private mode, blocked site data), so a bare `window.localStorage` is itself what can break.
 */
export function browserStore(): TokenStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readRefresh(store: TokenStore | null): string | null {
  if (!store) return null;
  try {
    const value = store.getItem(REFRESH_KEY);
    // An empty string is not a credential. A cleared key can read back as "".
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeRefresh(store: TokenStore | null, token: string): void {
  try {
    store?.setItem(REFRESH_KEY, token);
  } catch {
    // The session still works for this page; it just will not survive a reload.
  }
}

function clearRefresh(store: TokenStore | null): void {
  try {
    store?.removeItem(REFRESH_KEY);
  } catch {
    // A clear that fails leaves a credential behind, which is why memory is ALSO cleared and
    // nothing trusts this to have worked.
  }
}

export type SessionStatus =
  /** No refresh token: show the sign in screen. */
  | "signedOut"
  /** A refresh token is stored and is being exchanged. Render as signed in, optimistically. */
  | "restoring"
  | "signedIn";

export interface SessionState {
  status: SessionStatus;
  user: PublicUser | null;
}

/** Why a sign in or sign up did not work. NETWORK is "never reached a verdict". */
export type AuthFailure = AuthErrorCode | "NETWORK";
export type AuthOutcome = { ok: true } | { ok: false; error: AuthFailure };

/** Thrown by accessToken() when the server could not be reached, as distinct from signed out. */
export class SessionUnavailable extends Error {}

export interface SessionDeps {
  fetch: typeof fetch;
  storage: TokenStore | null;
  now: () => number;
  /**
   * Run fn holding a lock shared by every tab of this origin (navigator.locks). Two tabs
   * refreshing at once with the SAME stored token would look exactly like theft to the server,
   * which revokes the family and signs both out; the lock makes the second tab read the token the
   * first one just stored. Without it (an old browser) that race is possible, and costs a sign in.
   */
  lock?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** Schedules the refresh ahead of expiry. Omitted in tests that drive time by hand. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** navigator.locks, when this browser has it. */
export function browserLock(): SessionDeps["lock"] {
  const locks = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return undefined;
  return (name, fn) => locks.request(name, fn) as ReturnType<typeof fn>;
}

async function errorCode(response: Response): Promise<AuthFailure> {
  try {
    const body: unknown = await response.json();
    const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    if (typeof error === "string") return error as AuthErrorCode;
  } catch {
    // Not JSON: a proxy's error page, most likely. That is not a verdict about the credentials.
  }
  return "NETWORK";
}

export class SessionManager {
  private access: { token: string; expiresAt: number } | null = null;
  private user: PublicUser | null = null;
  private inflight: Promise<string | null> | null = null;
  private timer: unknown = null;
  private readonly listeners = new Set<(state: SessionState) => void>();

  constructor(private readonly deps: SessionDeps) {}

  state(): SessionState {
    if (this.user) return { status: "signedIn", user: this.user };
    return { status: readRefresh(this.deps.storage) ? "restoring" : "signedOut", user: null };
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** On page load: trade a stored refresh token for a session, if there is one. */
  async restore(): Promise<void> {
    if (this.user || !readRefresh(this.deps.storage)) return;
    try {
      await this.refresh();
    } catch {
      // Unreachable server. The stored token is kept, the state stays "restoring", and the next
      // thing that needs a token tries again.
    }
  }

  signIn(email: string, password: string): Promise<AuthOutcome> {
    return this.obtain("/api/auth/login", { email, password });
  }

  signUp(input: { invite?: string; email: string; password: string; displayName: string }): Promise<AuthOutcome> {
    return this.obtain("/api/auth/signup", input);
  }

  /**
   * Sign out: forget locally FIRST, then tell the server. The local half is what the person
   * asked for and it must happen even if the server cannot be reached; the server half revokes
   * the token so a copy of it (another tab, a stolen one) stops working too.
   */
  async signOut(): Promise<void> {
    const token = readRefresh(this.deps.storage);
    this.drop();
    if (!token) return;
    try {
      await this.deps.fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: token }),
        keepalive: true,
      });
    } catch {
      // Nothing to do. The token is gone from this browser; it expires on its own on the server.
    }
  }

  /**
   * Delete the account, proving the password again. On success the session is forgotten here
   * exactly as signOut forgets it (the server has already revoked every token it held).
   *
   * ONE request, never authorizedFetch's retry on a 401: a wrong password answers 401 too, and
   * retrying it would spend a second lockout strike on the same typo.
   */
  async deleteAccount(password: string): Promise<AuthOutcome> {
    let response: Response;
    try {
      const token = await this.accessToken();
      if (token === null) return { ok: false, error: "UNAUTHENTICATED" };
      response = await this.deps.fetch("/api/account", {
        method: "DELETE",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ password }),
      });
    } catch {
      return { ok: false, error: "NETWORK" };
    }
    if (!response.ok) return { ok: false, error: await errorCode(response) };
    this.drop();
    return { ok: true };
  }

  /**
   * A valid access token, refreshing first if it is missing or about to expire.
   *
   * Resolves null when there is no session to be had (signed out, or the server refused the
   * refresh token). THROWS SessionUnavailable when the server could not be reached, which is a
   * different fact: the caller should retry later rather than send the person to sign in.
   *
   * `force` refreshes even when the token in hand looks valid, for the caller that was just
   * refused with it (a 401, or a socket that never opened).
   */
  async accessToken(options: { force?: boolean } = {}): Promise<string | null> {
    const now = this.deps.now();
    if (!options.force && this.access && this.access.expiresAt - REFRESH_MARGIN_MS > now) {
      return this.access.token;
    }
    return this.refresh();
  }

  /** fetch with the access token, refreshed and retried once on a 401. */
  async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async (token: string | null) =>
      this.deps.fetch(path, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
    const first = await attempt(await this.accessToken());
    if (first.status !== 401) return first;
    return attempt(await this.accessToken({ force: true }));
  }

  dispose(): void {
    this.cancelTimer();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------

  private async obtain(path: string, body: unknown): Promise<AuthOutcome> {
    let response: Response;
    try {
      response = await this.deps.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, error: "NETWORK" };
    }
    if (!response.ok) return { ok: false, error: await errorCode(response) };
    try {
      this.adopt((await response.json()) as AuthSession);
    } catch {
      return { ok: false, error: "NETWORK" };
    }
    return { ok: true };
  }

  /** One refresh at a time in this tab, and (with a lock) across every tab. */
  private refresh(): Promise<string | null> {
    this.inflight ??= this.runRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runRefresh(): Promise<string | null> {
    const exchange = async (): Promise<string | null> => {
      // Read INSIDE the lock, not before it: another tab may have rotated the token while this
      // one waited, and the one it stored is the only one still good.
      const token = readRefresh(this.deps.storage);
      if (!token) {
        this.drop(false);
        return null;
      }
      let response: Response;
      try {
        response = await this.deps.fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: token }),
        });
      } catch {
        throw new SessionUnavailable("the server could not be reached");
      }
      if (response.status === 401 || response.status === 400) {
        // A verdict: this token is spent, revoked or expired. Only clear storage if it still
        // holds the token that was refused, so a newer one another tab just stored survives.
        if (readRefresh(this.deps.storage) === token) clearRefresh(this.deps.storage);
        this.drop(false);
        return null;
      }
      if (!response.ok) throw new SessionUnavailable(`refresh failed: ${response.status}`);
      const session = (await response.json()) as AuthSession;
      this.adopt(session);
      return session.accessToken;
    };
    return this.deps.lock ? this.deps.lock("translatv.refresh", exchange) : exchange();
  }

  private adopt(session: AuthSession): void {
    writeRefresh(this.deps.storage, session.refreshToken);
    this.access = { token: session.accessToken, expiresAt: session.accessExpiresAt };
    this.user = session.user;
    this.schedule(session.accessExpiresAt);
    this.notify();
  }

  /** Forget the session in memory, and in storage unless the caller has already decided that. */
  private drop(clearStorage = true): void {
    if (clearStorage) clearRefresh(this.deps.storage);
    this.access = null;
    this.cancelTimer();
    this.user = null;
    this.notify();
  }

  /** Refresh ahead of expiry, so a long call's reconnect never has to wait for one. */
  private schedule(expiresAt: number): void {
    this.cancelTimer();
    if (!this.deps.setTimer) return;
    const delay = Math.max(0, expiresAt - REFRESH_MARGIN_MS - this.deps.now());
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.refresh().catch(() => {
        // Unreachable right now. The next accessToken() call will try again.
      });
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.deps.clearTimer?.(this.timer);
    this.timer = null;
  }

  private notify(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
}
