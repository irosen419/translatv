// CORS for the account API and /healthz.
//
// Exists so the web client can be served as a static site on its own origin (deploy/static/,
// DEPLOY.md "Two services") and still talk to this server. Written here rather than pulled in as
// a dependency because the whole policy is a dozen lines and every one of them is a decision:
//
//   - The allowed origins are EXACTLY the ones the WebSocket upgrade allows (security/origin.ts),
//     echoed back one at a time. Never "*": a wildcard would let any page on the internet read
//     the answers to requests it makes with a token it got hold of.
//   - No Access-Control-Allow-Credentials. The API is bearer only (an Authorization header and
//     a refresh token in the JSON body), so there is no cookie for a browser to attach and nothing
//     to allow. Leaving it out also means a later cookie, added by someone who forgot this file,
//     is not silently sent cross origin.
//   - Vary: Origin on every answer, allowed or not, so a cache in front never serves one origin's
//     headers to another.
//   - A preflight is answered HERE and never reaches a route. The routes are where the per address
//     rate limits are taken, and a browser sends a preflight before most cross origin requests:
//     letting it through would spend a login attempt on every OPTIONS.
//   - An actual request is never refused here, allowed origin or not. It goes on to the same
//     limiter and the same bearer check a same origin request meets. CORS decides only whether a
//     browser lets the page READ the answer; it is not an access control, and the server's real
//     ones run unchanged behind it.

import type { NextFunction, Request, RequestHandler, Response } from "express";

/** The methods the account API and /healthz actually use. */
export const CORS_ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE"] as const;

/** The request headers the web client sends: its bearer token and its JSON bodies. */
export const CORS_ALLOWED_HEADERS = ["Authorization", "Content-Type"] as const;

/**
 * How long a browser may reuse a preflight answer. Ten minutes saves a round trip on almost every
 * request in a session, and still means removing an origin from ORIGIN takes effect quickly.
 */
export const CORS_MAX_AGE_SECONDS = 600;

function addVaryOrigin(res: Response): void {
  const existing = res.getHeader("Vary");
  const current = typeof existing === "string" ? existing : Array.isArray(existing) ? existing.join(", ") : "";
  if (/(^|,\s*)(origin|\*)(\s*,|$)/i.test(current)) return;
  res.setHeader("Vary", current ? `${current}, Origin` : "Origin");
}

/** CORS for the routes it is mounted on. `isAllowed` is the one origin rule (security/origin.ts). */
export function cors(isAllowed: (origin: string) => boolean): RequestHandler {
  const methods = new Set<string>(CORS_ALLOWED_METHODS);
  return (req: Request, res: Response, next: NextFunction) => {
    addVaryOrigin(res);
    const origin = req.headers.origin;
    const allowed = typeof origin === "string" && origin !== "" && isAllowed(origin);
    const requestedMethod = req.headers["access-control-request-method"];
    const isPreflight = req.method === "OPTIONS" && typeof requestedMethod === "string";

    if (isPreflight) {
      // Answered whatever the verdict, so it never falls through to a route or a limiter.
      if (!allowed || !methods.has(requestedMethod.toUpperCase())) {
        res.status(403).end();
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS.join(", "));
      res.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS.join(", "));
      res.setHeader("Access-Control-Max-Age", String(CORS_MAX_AGE_SECONDS));
      res.status(204).end();
      return;
    }

    if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
    next();
  };
}
