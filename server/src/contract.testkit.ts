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

function conforms(where: string, name: HttpSchemaName | "apiError", body: unknown): void {
  const schema = name === "apiError" ? apiError : HTTP_SCHEMAS[name];
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`${where}: the answer does not parse as ${name}: ${JSON.stringify(parsed.error.issues)}`);
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
 */
export async function expectContract(method: string, url: string, response: Response): Promise<HttpRoute | null> {
  const pathname = new URL(url).pathname;
  if (!pathname.startsWith("/api/") && pathname !== "/healthz") return null;
  const where = `${method} ${pathname} answered ${response.status}`;
  const route = routeFor(method, pathname);
  const text = await response.text();

  if (route && response.status === route.status) {
    if (route.response === null) {
      if (text !== "") throw new Error(`${where}: expected no body, got ${text.length} characters`);
    } else {
      conforms(where, route.response, JSON.parse(text) as unknown);
    }
    return route;
  }
  if (response.status < 400) throw new Error(`${where}: a success status the contract does not list`);
  conforms(where, "apiError", JSON.parse(text) as unknown);
  return null;
}
