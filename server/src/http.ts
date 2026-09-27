// The HTTP surface: security headers, a health check, and the built client.
//
// Small on purpose. Everything real in this app happens over the WebSocket; HTTP exists to
// deliver the SPA and to answer a load balancer.

import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express } from "express";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { mintAdminToken, passwordMatches } from "./security/adminAuth.js";
import { TokenBuckets } from "./security/rateLimit.js";
import { clientAddress } from "./ws/server.js";

/**
 * Login attempts per IP.
 *
 * A single password with no lockout is a guessing target, and this is the only place a guess
 * can be made. Deliberately tighter than the join limiter: nobody legitimately logs in five
 * times a minute, and the person who does is the owner, who can wait.
 */
const LOGIN_LIMIT = { burst: 5, ratePerSecond: 1 / 30 };

/**
 * Content Security Policy.
 *
 * connect-src must allow ws: and wss:, or the app cannot open its own socket. media-src must
 * allow blob:, or a MediaStream cannot be attached to a video element. Those two are the ones
 * people get wrong and then debug for an hour.
 *
 * 'unsafe-inline' for styles only, and only because Vite inlines a small critical style block.
 * There is no 'unsafe-inline' for scripts, which is the one that actually matters for XSS.
 */
function contentSecurityPolicy(isProduction: boolean): string {
  const connect = isProduction ? "'self' ws: wss:" : "'self' ws: wss: http://localhost:*";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connect}`,
    "media-src 'self' blob:",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

export interface TranslationStatus {
  /** False once a terminal failure (a rejected key, a wrong model) has latched translation off. */
  readonly enabled: boolean;
  /** Why it turned itself off, or null. */
  readonly disabled: string | null;
}

export function createApp(
  config: Config,
  clientDist: string,
  translation?: TranslationStatus,
): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", contentSecurityPolicy(config.isProduction));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // Camera and microphone are the whole app, so they are granted to self. Everything else
    // this page has no business asking for is denied outright.
    res.setHeader(
      "Permissions-Policy",
      "microphone=(self), camera=(self), geolocation=(), payment=(), usb=()",
    );
    next();
  });

  // Bounded hard. This is the only unauthenticated body this server parses, and the password
  // it carries is short by definition.
  const loginBody = express.json({ limit: "1kb" });
  const loginLimiter = new TokenBuckets(LOGIN_LIMIT);

  /**
   * Trade the admin password for a token.
   *
   * Deliberately one flat answer for every failure: wrong password, no password configured,
   * malformed body. A caller learns whether they got in and nothing else, because the
   * differences are exactly what a guesser would use to narrow down which half of the setup
   * they are up against.
   *
   * The password is never logged, at any level. The logger drops a `text` field by contract and
   * nothing here hands it one, but the rule matters more than the mechanism: a credential in a
   * log file outlives every rotation of the credential itself.
   */
  app.post("/auth/login", loginBody, (req, res) => {
    const now = Date.now();
    // Swept on every attempt. Nothing else ever calls this limiter, so without it the map grew
    // one entry per distinct address for the life of the process and never shrank. Cheap here
    // precisely because this endpoint is the rate limited one.
    loginLimiter.sweep(now);
    const ip = clientAddress(req.headers, req.socket.remoteAddress, config.trustProxy);
    if (!loginLimiter.take(ip, now)) {
      log.warn("auth.rate_limited", {});
      res.status(429).json({ ok: false });
      return;
    }

    const body: unknown = req.body;
    const candidate =
      typeof body === "object" && body !== null && typeof (body as { password?: unknown }).password === "string"
        ? (body as { password: string }).password
        : null;

    if (candidate === null || config.adminPassword === null || !passwordMatches(candidate, config.adminPassword)) {
      log.warn("auth.refused", {});
      res.status(401).json({ ok: false });
      return;
    }

    log.info("auth.ok", {});
    res.json({ ok: true, token: mintAdminToken(config.adminPassword, now) });
  });

  app.get("/healthz", (_req, res) => {
    // Distinguishes "no key configured" from "the key was rejected at runtime". Both leave
    // translation off, but only one of them is a mistake someone needs to go fix, and an
    // operator should not have to grep logs to tell which they have.
    const configured = config.anthropicApiKey !== null;
    const brokenAtRuntime = configured && translation?.enabled === false;

    res.json({
      ok: true,
      // Whether the admin gate is switched on at all, so the client can tell "you are not the
      // admin" from "this server has no admin". Without it the client has to guess, and a guess
      // either greys out the Start button on an ungated server (nobody can use the app) or
      // leaves it live on a gated one (everybody presses a button that refuses them).
      //
      // A boolean, never the password or anything derived from it.
      adminRequired: config.adminPassword !== null,
      translation: brokenAtRuntime ? "failed" : configured ? "enabled" : "not_configured",
      ...(brokenAtRuntime && translation?.disabled ? { reason: translation.disabled } : {}),
    });
  });

  if (existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false }));
    // SPA fallback. /r/<code> must serve the app rather than 404, so a shared room link works
    // as a first navigation rather than only as a client side route.
    app.get("*", (_req, res) => {
      res.sendFile(join(clientDist, "index.html"));
    });
  } else {
    app.get("*", (_req, res) => {
      res
        .status(503)
        .type("text/plain")
        .send(
          "The client has not been built yet.\n\n" +
            "Run `npm run build --workspace=client`, or use `npm run dev` for development\n" +
            "with hot reload on the Vite port.\n",
        );
    });
  }

  return app;
}
