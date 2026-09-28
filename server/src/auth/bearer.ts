// Where an access token rides on a request.
//
// HTTP and native WebSocket clients send `Authorization: Bearer <token>`. A browser cannot set
// headers on a WebSocket, so the web client offers it as a SUBPROTOCOL instead:
//
//   new WebSocket(url, ["translatv.v1", "bearer.<token>"])
//
// and the server selects "translatv.v1". The token never goes in the URL, where it would land in
// proxy access logs and browser history. The subprotocol header is not logged by anything in
// front of this server by default, and the server never echoes the bearer entry back: it selects
// the app protocol only, so the token appears once, in the request, and nowhere in the response.

import type { IncomingHttpHeaders } from "node:http";

/** The subprotocol a browser client offers and this server selects. */
export const APP_SUBPROTOCOL = "translatv.v1";

/** The prefix of the subprotocol entry that carries the access token. */
export const BEARER_SUBPROTOCOL_PREFIX = "bearer.";

export function bearerFromHeader(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  return match?.[1] ?? null;
}

/** The access token on a WebSocket upgrade, from either place, or null. */
export function bearerFromUpgrade(headers: IncomingHttpHeaders): string | null {
  const fromHeader = bearerFromHeader(headers.authorization);
  if (fromHeader !== null) return fromHeader;

  const offered = headers["sec-websocket-protocol"];
  if (typeof offered !== "string") return null;
  for (const entry of offered.split(",")) {
    const protocol = entry.trim();
    if (protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX) && protocol.length > BEARER_SUBPROTOCOL_PREFIX.length) {
      return protocol.slice(BEARER_SUBPROTOCOL_PREFIX.length);
    }
  }
  return null;
}

/** ws's handleProtocols: the app protocol when offered, otherwise none. Never the bearer entry. */
export function selectSubprotocol(offered: Set<string>): string | false {
  return offered.has(APP_SUBPROTOCOL) ? APP_SUBPROTOCOL : false;
}
