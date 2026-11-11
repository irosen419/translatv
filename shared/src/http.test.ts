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
    supportEmail: null,
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

describe("the safety routes", () => {
  const byId = (id: string) => HTTP_ROUTES.find((route) => route.id === id);

  it("are listed, each with the schema the server parses and answers with", () => {
    expect(byId("me.blocks.get")).toMatchObject({ method: "GET", path: "/api/me/blocks", bearer: true, request: null, status: 200, response: "blocksResponse" });
    expect(byId("me.blocks.create")).toMatchObject({ method: "POST", path: "/api/me/blocks", bearer: true, request: { in: "body", schema: "contactRef" }, status: 200, response: "blocksResponse" });
    expect(byId("me.blocks.delete")).toMatchObject({ method: "DELETE", path: "/api/me/blocks", bearer: true, request: { in: "body", schema: "contactRef" }, status: 200, response: "blocksResponse" });
    expect(byId("me.reports.create")).toMatchObject({ method: "POST", path: "/api/me/reports", bearer: true, request: { in: "body", schema: "reportRequest" }, status: 201, response: "reportReceipt" });
    expect(byId("owner.reports.list")).toMatchObject({ method: "GET", path: "/api/owner/reports", bearer: true, request: null, status: 200, response: "reportsResponse" });
    expect(byId("owner.reports.review")).toMatchObject({ method: "POST", path: "/api/owner/reports/review", bearer: true, request: { in: "body", schema: "reviewReportRequest" }, status: 200, response: "ownerReport" });
  });

  it("have codes for a contact or report that is not there", () => {
    expect(AUTH_ERROR_CODES).toContain("CONTACT_NOT_FOUND");
    expect(AUTH_ERROR_CODES).toContain("REPORT_NOT_FOUND");
  });
});

describe("healthResponse's support contact", () => {
  const body = { ok: true, protocolVersion: PROTOCOL_VERSION, apiVersion: API_VERSION, signup: "invite", translation: "enabled" };

  it("is an address, or null when the server has none", () => {
    expect(healthResponse.safeParse({ ...body, supportEmail: "help@example.test" }).success).toBe(true);
    expect(healthResponse.safeParse({ ...body, supportEmail: null }).success).toBe(true);
  });

  it("is always present, so a client never has to guess what absence means", () => {
    expect(healthResponse.safeParse(body).success).toBe(false);
  });
});
