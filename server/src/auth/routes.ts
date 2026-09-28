// The account API: /api/auth/*, /api/invites, and (M5) the per user data under /api/me/* and
// DELETE /api/account.
//
// Thin on purpose. AuthService decides; this maps its answers to status codes, parses and bounds
// the body, and applies the per IP limits. Every error body is `{ error: <code> }` and nothing
// else, because the client chooses the sentence (shared/src/auth.ts).
//
// Credentials never reach the log from here. The logger withholds email, password and every
// token key by contract (log.ts), but the stronger rule is that nothing here hands it one.

import express, { type NextFunction, type Request, type Response, type Router } from "express";
import type { AuthErrorCode } from "@translatv/shared";

import type { AccountService } from "../account/service.js";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { TokenBuckets, type BucketConfig } from "../security/rateLimit.js";
import { clientAddress } from "../ws/server.js";
import { bearerFromHeader } from "./bearer.js";
import type { AuthResult, AuthService } from "./service.js";

/**
 * Per IP limits, one bucket set per kind of request.
 *
 * Separate buckets because the requests differ in cost and in what a flood of them means. Login is
 * a guessing target and gets the tightest refill; the per account lockout in AuthService is the
 * second wall behind it. Signup is rare for a person and allows a burst so one household can
 * make its accounts in a sitting. Refresh is routine, about four an hour per open tab plus one
 * per page load, and is only limited enough that a loop cannot hammer the database.
 */
export const AUTH_LIMITS = {
  signup: { burst: 10, ratePerSecond: 10 / 3600 },
  login: { burst: 10, ratePerSecond: 1 / 6 },
  refresh: { burst: 30, ratePerSecond: 1 },
  account: { burst: 30, ratePerSecond: 1 },
} as const satisfies Record<string, BucketConfig>;

/** The HTTP status for each refusal. */
const STATUS: Record<AuthErrorCode, number> = {
  INVALID_INPUT: 400,
  WEAK_PASSWORD: 400,
  INVITE_INVALID: 403,
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  LOCKED: 429,
  INVALID_REFRESH: 401,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  ACCOUNT_MISMATCH: 409,
  RATE_LIMITED: 429,
};

function fail(res: Response, error: AuthErrorCode): void {
  res.status(STATUS[error]).json({ error });
}

function answer<T>(res: Response, result: AuthResult<T>, okStatus = 200): void {
  if (result.ok) res.status(okStatus).json(result.value);
  else fail(res, result.error);
}

/**
 * The body limit for PUT /api/me/glossary, the one route whose honest body is larger than 4kb.
 * The largest valid glossary is LIMITS.glossaryEntries entries of a 200 and a 400 character
 * term: 24,000 characters, which JSON can spell as up to six bytes each (a backslash u escape), so about
 * 150kb. Anything past this is refused before it is parsed.
 */
export const GLOSSARY_BODY_LIMIT = "256kb";

export function createAuthRouter(config: Config, auth: AuthService, account?: AccountService): Router {
  const router = express.Router();
  const limiters = {
    signup: new TokenBuckets(AUTH_LIMITS.signup),
    login: new TokenBuckets(AUTH_LIMITS.login),
    refresh: new TokenBuckets(AUTH_LIMITS.refresh),
    account: new TokenBuckets(AUTH_LIMITS.account),
  };

  // Nothing about a session may be cached by a proxy or the browser.
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Bounded hard. The largest honest body is a signup, a few hundred bytes, except for a stored
  // glossary, which gets its own larger limit on its own route and is the only exception.
  const smallJson = express.json({ limit: "4kb" });
  router.use((req, res, next) => {
    if (req.method === "PUT" && req.path === "/me/glossary") {
      next();
      return;
    }
    smallJson(req, res, next);
  });

  /** Take a token from one bucket for this address, or answer 429 and return false. */
  const limited = (kind: keyof typeof limiters) => (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const limiter = limiters[kind];
    // Swept on every request, because nothing else ever calls these limiters: without it each
    // map would grow one entry per distinct address for the life of the process.
    limiter.sweep(now);
    const ip = clientAddress(req.headers, req.socket.remoteAddress, config.trustProxy);
    if (!limiter.take(ip, now)) {
      log.warn("auth.rate_limited", { kind });
      fail(res, "RATE_LIMITED");
      return;
    }
    next();
  };

  /** The signed in user's id, or answer 401 and return null. */
  const requireUser = (req: Request, res: Response): string | null => {
    const token = bearerFromHeader(req.headers.authorization);
    const userId = token === null ? null : auth.verifyAccess(token, Date.now());
    if (userId === null) fail(res, "UNAUTHENTICATED");
    return userId;
  };

  router.post("/auth/signup", limited("signup"), (req, res, next) => {
    auth.signup(req.body, Date.now()).then((result) => answer(res, result, 201), next);
  });

  router.post("/auth/login", limited("login"), (req, res, next) => {
    auth.login(req.body, Date.now()).then((result) => answer(res, result), next);
  });

  router.post("/auth/refresh", limited("refresh"), (req, res) => {
    answer(res, auth.refresh(req.body, Date.now()));
  });

  // 204 whatever happened. Telling a caller whether a token was live is an answer they have no
  // use for except to test stolen ones.
  router.post("/auth/logout", limited("refresh"), (req, res) => {
    auth.logout(req.body, Date.now());
    res.status(204).end();
  });

  router.get("/auth/me", limited("account"), (req, res) => {
    const userId = requireUser(req, res);
    if (userId === null) return;
    const user = auth.userFor(userId);
    if (!user) {
      fail(res, "UNAUTHENTICATED");
      return;
    }
    res.json({ user });
  });

  router.post("/invites", limited("account"), (req, res) => {
    const userId = requireUser(req, res);
    if (userId === null) return;
    if (auth.userFor(userId)?.isOwner !== true) {
      fail(res, "FORBIDDEN");
      return;
    }
    const invite = auth.createInvite(userId, Date.now());
    log.info("invite.created", { by: userId });
    res.status(201).json(invite);
  });

  // Deleting the account. On the LOGIN bucket, not the account one, because it checks a password
  // and is therefore a guessing target; the lockout in AuthService is the wall behind it.
  router.delete("/account", limited("login"), (req, res, next) => {
    const userId = requireUser(req, res);
    if (userId === null) return;
    auth.deleteAccount(userId, req.body, Date.now()).then((result) => {
      if (result.ok) res.status(204).end();
      else fail(res, result.error);
    }, next);
  });

  // Per user data (M5). Absent only in tests of the auth routes on their own.
  if (account) {
    router.get("/me/preferences", limited("account"), (req, res) => {
      const userId = requireUser(req, res);
      if (userId === null) return;
      res.json(account.preferencesFor(userId));
    });

    router.put("/me/preferences", limited("account"), (req, res) => {
      const userId = requireUser(req, res);
      if (userId === null) return;
      answer(res, account.setPreferences(userId, req.body, Date.now()));
    });

    router.get("/me/glossary", limited("account"), (req, res) => {
      const userId = requireUser(req, res);
      if (userId === null) return;
      res.json({ entries: account.glossaryFor(userId) });
    });

    // The limiter and the bearer come BEFORE the large body parser, so an anonymous or flooding
    // caller is refused without the server reading 256kb on their behalf.
    router.put(
      "/me/glossary",
      limited("account"),
      (req, res, next) => {
        const userId = requireUser(req, res);
        if (userId === null) return;
        res.locals["userId"] = userId;
        next();
      },
      express.json({ limit: GLOSSARY_BODY_LIMIT }),
      (req, res) => {
        answer(res, account.setGlossary(String(res.locals["userId"]), req.body));
      },
    );

    router.get("/me/calls", limited("account"), (req, res) => {
      const userId = requireUser(req, res);
      if (userId === null) return;
      answer(res, account.callsFor(userId, req.query));
    });

    router.get("/me/contacts", limited("account"), (req, res) => {
      const userId = requireUser(req, res);
      if (userId === null) return;
      res.json(account.contactsFor(userId));
    });
  }

  // Unknown paths under /api answer a code rather than falling through to the SPA's index.html,
  // which would hand a JSON client an HTML page with a 200.
  router.use((_req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });

  // Body parse failures (malformed JSON, too large) arrive here from express.json. Answered as a
  // code, never Express's default HTML page with a stack trace in development.
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: unknown }).status;
    if (status === 413) {
      res.status(413).json({ error: "INVALID_INPUT" });
      return;
    }
    if (status === 400) {
      fail(res, "INVALID_INPUT");
      return;
    }
    log.error("auth.handler_failed", { error: error instanceof Error ? error.message : "unknown" });
    res.status(500).json({ error: "INTERNAL" });
  });

  return router;
}
