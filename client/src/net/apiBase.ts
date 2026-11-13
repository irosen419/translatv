// Where the server is: the one module that knows.
//
// By default the web client is served by the translatv server itself, so every request is a
// relative path and the socket follows the page's own host. Built with VITE_API_ORIGIN set, the
// client is a static site on its OWN origin and the server is elsewhere (DEPLOY.md, "Two
// services"): requests go to that origin, through CORS, and the socket goes there too, its Origin
// checked against the server's ORIGIN allowlist.
//
// EVERY request the client makes to the server names its path through apiUrl(). A bare
// "/api/..." would resolve against the static host, which answers with its SPA fallback and a
// 200, and fail far from the cause. apiBase.guard.test.ts greps the client to keep it that way.
//
// Nothing about credentials changes with the origin. The access token is an Authorization header
// on fetch and a "bearer." subprotocol on the socket, the refresh token a JSON body field; none of
// it is a cookie, so nothing here depends on being same origin, and no token ever goes in a URL.

import { WS_PATH } from "@translatv/shared";

import { parseApiOrigin } from "./apiOrigin.js";

/**
 * The server's origin, or "" for the page's own. Read and checked once, at load: a bad value
 * throws here, before the app renders, rather than turning into relative paths.
 */
export const API_ORIGIN: string = parseApiOrigin(import.meta.env.VITE_API_ORIGIN);

/** `path` on the server at `origin` ("" for this page's own). The path must start with one "/". */
export function apiUrlFor(origin: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`apiUrl takes a path that starts with a single "/", got ${JSON.stringify(path)}`);
  }
  return `${origin}${path}`;
}

/** `path` on the translatv server, wherever it is. */
export function apiUrl(path: string): string {
  return apiUrlFor(API_ORIGIN, path);
}

/** The slice of `location` the socket URL needs. */
export interface PageLocation {
  protocol: string;
  host: string;
}

/**
 * The signaling socket's URL: the API origin's host with ws or wss to match its scheme, or the
 * page's own host when the API is same origin. Always with WS_PATH (socket.ts says why).
 */
export function wsUrlFor(origin: string, page: PageLocation): string {
  if (origin === "") {
    const protocol = page.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${page.host}${WS_PATH}`;
  }
  const url = new URL(origin);
  const protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${url.host}${WS_PATH}`;
}
