// The HTTP surface: security headers, a health check, and the built client.
//
// Small on purpose. Everything real in a call happens over the WebSocket; HTTP exists to deliver
// the SPA, to answer a load balancer, and to carry the account API under /api (auth/routes.ts).

import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express } from "express";
import { PROTOCOL_VERSION } from "@translatv/shared";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { createAuthRouter } from "./auth/routes.js";
import type { AuthService } from "./auth/service.js";
import type { AccountService } from "./account/service.js";

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
  auth?: AuthService,
  account?: AccountService,
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

  // The account API. Absent only in tests that exercise the rest of the surface on its own; the
  // real server always passes one.
  if (auth) app.use("/api", createAuthRouter(config, auth, account));

  app.get("/healthz", (_req, res) => {
    // Distinguishes "no key configured" from "the key was rejected at runtime". Both leave
    // translation off, but only one of them is a mistake someone needs to go fix, and an
    // operator should not have to grep logs to tell which they have.
    const configured = config.anthropicApiKey !== null;
    const brokenAtRuntime = configured && translation?.enabled === false;

    res.json({
      ok: true,
      // Which wire format this server speaks, so a separately shipped client (the iOS app) can
      // check it is compatible before it opens a socket rather than after its first bad frame.
      protocolVersion: PROTOCOL_VERSION,
      // Whether signing up needs an invite, so a client shows the invite field only where it
      // means something. The mode, never anything about who has an account.
      signup: config.signupMode,
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
