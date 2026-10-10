// Test support: checks a real HTTP answer against the EXPORTED contract, the generated
// shared/wire/http.schema.json that the iOS app is built and tested against (docs/PLAN.md, D7).
//
// A fixture that parses proves only that the fixture matches the schema. It says nothing about
// whether the server sends that shape, which is the join the app actually depends on. So the
// route tests pass every answer through here: the route is looked up in HTTP_ROUTES by method and
// path, and the body must satisfy both the zod schema (the source of truth) and the exported JSON
// Schema compiled by Ajv in strict mode (what a second implementation reads).
//
// Not a test file (no suite of its own) and not part of the build: server/tsconfig.json excludes
// *.testkit.ts, so Ajv, a dev dependency, never reaches the image.

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { apiError, HTTP_ROUTES, HTTP_SCHEMAS, type HttpRoute, type HttpSchemaName } from "@translatv/shared";

const HTTP_SCHEMA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "wire", "http.schema.json");

let ajv: Ajv | null = null;

function exported(name: HttpSchemaName | "apiError") {
  if (ajv === null) {
    ajv = new Ajv({ strict: true, allErrors: true });
    ajv.addSchema(JSON.parse(readFileSync(HTTP_SCHEMA, "utf8")) as object, "http");
  }
  const validate = ajv.getSchema(`http#/definitions/${name}`);
  if (!validate) throw new Error(`http.schema.json has no definition ${name}`);
  return validate;
}

function conforms(where: string, name: HttpSchemaName | "apiError", body: unknown, whole = false): void {
  const schema = name === "apiError" ? apiError : HTTP_SCHEMAS[name];
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`${where}: the answer does not parse as ${name}: ${JSON.stringify(parsed.error.issues)}`);
  }
  // An answer must come back from its schema unchanged. zod drops keys a schema does not know and
  // the exported schema allows extra keys, so without this a table naming a schema with FEWER
  // fields than the server sends passes, and a client built from it never decodes them (review
  // round 2 named meResponse for signup, which dropped both tokens, with every gate green).
  if (whole && !isDeepStrictEqual(parsed.data, body)) {
    throw new Error(`${where}: ${name} does not describe the whole answer: ${JSON.stringify(body)}`);
  }
  const validate = exported(name);
  if (!validate(body)) {
    throw new Error(`${where}: the exported schema refuses the answer as ${name}: ${JSON.stringify(validate.errors)}`);
  }
}

/** The contract entry for a request, or undefined when the table has none. */
export function routeFor(method: string, pathname: string): HttpRoute | undefined {
  return HTTP_ROUTES.find((route) => route.method === method && route.path === pathname);
}

/**
 * Throws unless the answer is one the contract describes.
 *
 * A route's success status must carry the route's response schema (or no body at all for 204).
 * Anything else from the account API must be the error body. Returns the route when the answer
 * was that route's success, so a caller can count which routes were really exercised.
 *
 * On a success, the REQUEST is checked too: the server accepted it, so the schema the table
 * publishes for that route's request must accept it as well. Without this, the table could name
 * the wrong request schema with every gate green, and a client built from it would send a body the
 * server refuses (review round 1 pointed DELETE /api/account at loginRequest, and nothing failed).
 * A JSON body is checked against both the zod schema and the exported one. A query string is
 * checked against zod only: its values are strings on the wire, which zod coerces and the exported
 * JSON Schema, describing the decoded values, does not.
 */
export async function expectContract(
  method: string,
  url: string,
  response: Response,
  body?: RequestInit["body"],
): Promise<HttpRoute | null> {
  const parsedUrl = new URL(url);
  const pathname = parsedUrl.pathname;
  if (!pathname.startsWith("/api/") && pathname !== "/healthz") return null;
  const where = `${method} ${pathname} answered ${response.status}`;
  const route = routeFor(method, pathname);
  const text = await response.text();

  if (route && response.status === route.status) {
    if (route.response === null) {
      if (text !== "") throw new Error(`${where}: expected no body, got ${text.length} characters`);
    } else {
      conforms(where, route.response, JSON.parse(text) as unknown, true);
    }
    if (route.request?.in === "body") {
      if (typeof body !== "string") throw new Error(`${where}: the route takes a JSON body, and the request sent none`);
      conforms(`${where}, its request`, route.request.schema, JSON.parse(body) as unknown);
    } else if (route.request?.in === "query") {
      const query = Object.fromEntries(parsedUrl.searchParams);
      const parsed = HTTP_SCHEMAS[route.request.schema].safeParse(query);
      if (!parsed.success) {
        throw new Error(`${where}: its query does not parse as ${route.request.schema}: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
    return route;
  }
  if (response.status < 400) throw new Error(`${where}: a success status the contract does not list`);
  conforms(where, "apiError", JSON.parse(text) as unknown);
  return null;
}
