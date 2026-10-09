// The HTTP contract: every route the server answers over HTTP that a client in another language
// (the iOS app) speaks, with its request and response schemas, and the account API's version.
//
// The schemas themselves live where they always did (auth.ts, account.ts); this file is the TABLE
// that says which schema goes with which route. It is what script/gen_wire.mjs exports
// (shared/wire/http.schema.json, and the route list in constants.json), what check_wire.mjs
// demands a fixture for, and what server/src/auth/routes.test.ts checks every real answer
// against. A route missing here is a route with no exported schema, no fixture and no check, and
// routes.test.ts fails if the router mounts a route this table does not list.

import { z } from "zod";

import {
  apiError,
  authSession,
  inviteResponse,
  loginRequest,
  logoutRequest,
  meResponse,
  refreshRequest,
  signupMode,
  signupRequest,
} from "./auth.js";
import {
  callsPage,
  callsQuery,
  contactsResponse,
  deleteAccountRequest,
  glossaryDocument,
  preferences,
} from "./account.js";

/**
 * The version of the HTTP account API described by this file and the schemas it names.
 *
 * Served on /healthz beside PROTOCOL_VERSION, for the same reason: the iOS app ships on its own
 * schedule, and reads /healthz when it starts to learn whether it can talk to this server. The web
 * client ships with the server, so it never sees a mismatch. There is no version in the path.
 *
 * The same bump rule as PROTOCOL_VERSION: bump it on any change a client already in the field
 * could not handle, such as a removed or renamed field, a new required request field, a changed
 * meaning, a changed status, or a removed route. Adding an optional request field, a response
 * field an old client can ignore, or a new route does not need a bump.
 */
export const API_VERSION = 1;

/** GET /healthz. Read by load balancers, and by the iOS app before it opens a socket. */
export const healthResponse = z.object({
  ok: z.literal(true),
  /** The WebSocket wire format this server speaks (PROTOCOL_VERSION). */
  protocolVersion: z.number().int().positive(),
  /** The HTTP account API this server speaks (API_VERSION). */
  apiVersion: z.number().int().positive(),
  /** Whether signing up needs an invite. The mode, never anything about who has an account. */
  signup: signupMode,
  /** "failed" is a key that was rejected at runtime; "not_configured" is no key at all. */
  translation: z.enum(["enabled", "not_configured", "failed"]),
  /** Why translation failed, for an operator. Present only with "failed", and not always then. */
  reason: z.string().optional(),
});
export type HealthResponse = z.infer<typeof healthResponse>;

/** Every schema a route names, by the name it is exported under. */
export const HTTP_SCHEMAS = {
  healthResponse,
  apiError,
  signupRequest,
  loginRequest,
  refreshRequest,
  logoutRequest,
  authSession,
  meResponse,
  inviteResponse,
  deleteAccountRequest,
  preferences,
  glossaryDocument,
  callsQuery,
  callsPage,
  contactsResponse,
} as const;
export type HttpSchemaName = keyof typeof HTTP_SCHEMAS;

export interface HttpRoute {
  /** Stable, and the stem of the route's fixture names: `<id>.request.json`, `<id>.response.json`. */
  readonly id: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  /** Whether it needs `Authorization: Bearer <access token>`. */
  readonly bearer: boolean;
  /** A JSON body, or the query string (GET /api/me/calls), or nothing. */
  readonly request: { readonly in: "body" | "query"; readonly schema: HttpSchemaName } | null;
  /** The status of a success. Every other status carries apiError. */
  readonly status: 200 | 201 | 204;
  /** The success body's schema, or null for 204 No Content. */
  readonly response: HttpSchemaName | null;
}

const body = (schema: HttpSchemaName) => ({ in: "body", schema }) as const;

/** Every route, in the order the router declares them. */
export const HTTP_ROUTES: readonly HttpRoute[] = [
  {
    id: "healthz", method: "GET", path: "/healthz",
    bearer: false, request: null,
    status: 200, response: "healthResponse",
  },
  {
    id: "auth.signup", method: "POST", path: "/api/auth/signup",
    bearer: false, request: body("signupRequest"),
    status: 201, response: "authSession",
  },
  {
    id: "auth.login", method: "POST", path: "/api/auth/login",
    bearer: false, request: body("loginRequest"),
    status: 200, response: "authSession",
  },
  {
    id: "auth.refresh", method: "POST", path: "/api/auth/refresh",
    bearer: false, request: body("refreshRequest"),
    status: 200, response: "authSession",
  },
  {
    id: "auth.logout", method: "POST", path: "/api/auth/logout",
    bearer: false, request: body("logoutRequest"),
    status: 204, response: null,
  },
  {
    id: "auth.me", method: "GET", path: "/api/auth/me",
    bearer: true, request: null,
    status: 200, response: "meResponse",
  },
  {
    id: "invites.create", method: "POST", path: "/api/invites",
    bearer: true, request: null,
    status: 201, response: "inviteResponse",
  },
  {
    id: "account.delete", method: "DELETE", path: "/api/account",
    bearer: true, request: body("deleteAccountRequest"),
    status: 204, response: null,
  },
  {
    id: "me.preferences.get", method: "GET", path: "/api/me/preferences",
    bearer: true, request: null,
    status: 200, response: "preferences",
  },
  {
    id: "me.preferences.put", method: "PUT", path: "/api/me/preferences",
    bearer: true, request: body("preferences"),
    status: 200, response: "preferences",
  },
  {
    id: "me.glossary.get", method: "GET", path: "/api/me/glossary",
    bearer: true, request: null,
    status: 200, response: "glossaryDocument",
  },
  {
    id: "me.glossary.put", method: "PUT", path: "/api/me/glossary",
    bearer: true, request: body("glossaryDocument"),
    status: 200, response: "glossaryDocument",
  },
  {
    id: "me.calls", method: "GET", path: "/api/me/calls",
    bearer: true, request: { in: "query", schema: "callsQuery" },
    status: 200, response: "callsPage",
  },
  {
    id: "me.contacts", method: "GET", path: "/api/me/contacts",
    bearer: true, request: null,
    status: 200, response: "contactsResponse",
  },
];

/**
 * Every golden fixture the HTTP contract needs: one per request and one per response body, and one
 * error body. Derived from HTTP_ROUTES, so adding a route adds the fixtures it owes.
 */
export const HTTP_FIXTURES: ReadonlyArray<{ readonly name: string; readonly schema: HttpSchemaName }> = [
  ...HTTP_ROUTES.flatMap((route) => [
    ...(route.request ? [{ name: `${route.id}.request`, schema: route.request.schema }] : []),
    ...(route.response ? [{ name: `${route.id}.response`, schema: route.response }] : []),
  ]),
  { name: "error", schema: "apiError" },
];
