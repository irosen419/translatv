// The HTTP contract table. It is what the exported schema, the fixtures, and the server's route
// tests are all checked against, so a mistake in it would be repeated faithfully by every one of
// them. These are the properties the others take for granted.

import { describe, expect, it } from "vitest";

import { API_ERROR_CODES, apiError, AUTH_ERROR_CODES } from "./auth.js";
import { API_VERSION, healthResponse, HTTP_ROUTES, HTTP_SCHEMAS } from "./http.js";
import { PROTOCOL_VERSION } from "./protocol.js";

describe("API_VERSION", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(API_VERSION)).toBe(true);
    expect(API_VERSION).toBeGreaterThan(0);
  });
});

describe("HTTP_ROUTES", () => {
  it("names each route once, by id and by method and path", () => {
    const ids = HTTP_ROUTES.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = HTTP_ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("refers only to schemas it exports", () => {
    for (const route of HTTP_ROUTES) {
      for (const name of [route.request?.schema, route.response].filter((n) => n !== null && n !== undefined)) {
        expect(Object.keys(HTTP_SCHEMAS), `${route.id}: ${String(name)}`).toContain(name);
      }
    }
  });

  it("answers 204 exactly when there is no body to describe", () => {
    for (const route of HTTP_ROUTES) {
      expect(route.response === null, route.id).toBe(route.status === 204);
    }
  });

  it("puts a request body only on methods that carry one", () => {
    for (const route of HTTP_ROUTES) {
      if (route.request?.in === "body") expect(["POST", "PUT", "DELETE"], route.id).toContain(route.method);
      if (route.request?.in === "query") expect(route.method, route.id).toBe("GET");
    }
  });
});

describe("apiError", () => {
  it("covers every account API code, and the router's own two", () => {
    expect([...API_ERROR_CODES].sort()).toEqual([...AUTH_ERROR_CODES, "INTERNAL", "NOT_FOUND"].sort());
  });

  it("is the code and nothing else", () => {
    expect(apiError.safeParse({ error: "NOT_FOUND" }).success).toBe(true);
    expect(apiError.safeParse({ error: "that page does not exist" }).success).toBe(false);
  });
});

describe("healthResponse", () => {
  const body = {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    apiVersion: API_VERSION,
    signup: "invite",
    translation: "failed",
    reason: "the key was rejected",
  };

  it("describes /healthz with both versions", () => {
    expect(healthResponse.safeParse(body).success).toBe(true);
    const { apiVersion: _api, ...withoutApi } = body;
    expect(healthResponse.safeParse(withoutApi).success).toBe(false);
    const { protocolVersion: _protocol, ...withoutProtocol } = body;
    expect(healthResponse.safeParse(withoutProtocol).success).toBe(false);
  });

  it("takes any positive integer version, so an app can read a newer server's and refuse politely", () => {
    expect(healthResponse.safeParse({ ...body, apiVersion: API_VERSION + 5 }).success).toBe(true);
    expect(healthResponse.safeParse({ ...body, apiVersion: 0 }).success).toBe(false);
  });
});
