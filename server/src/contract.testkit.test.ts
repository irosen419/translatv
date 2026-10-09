// The contract helper is what routes.test.ts and http.test.ts lean on to prove the server sends the
// exported shapes. A helper that quietly accepted everything would leave both suites green while
// proving nothing, so each of its branches is shown here to refuse what it should.

import { afterEach, describe, expect, it, vi } from "vitest";

const BASE = "http://127.0.0.1:1";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const user = { id: "u1", displayName: "Ana", isOwner: false };

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("expectContract", () => {
  it("accepts a route's success body and returns the route", async () => {
    const { expectContract } = await import("./contract.testkit.js");
    expect((await expectContract("GET", `${BASE}/api/auth/me`, json({ user })))?.id).toBe("auth.me");
  });

  it("refuses a success body that does not parse as the route's schema", async () => {
    const { expectContract } = await import("./contract.testkit.js");
    await expect(expectContract("GET", `${BASE}/api/auth/me`, json(user))).rejects.toThrow(/does not parse as meResponse/);
  });

  it("accepts an empty 204, and refuses a success status the contract does not list", async () => {
    const { expectContract } = await import("./contract.testkit.js");
    expect((await expectContract("POST", `${BASE}/api/auth/logout`, new Response(null, { status: 204 })))?.id).toBe(
      "auth.logout",
    );
    await expect(expectContract("POST", `${BASE}/api/invites`, json({ code: "x", expiresAt: 1 }, 200))).rejects.toThrow(
      /a success status the contract does not list/,
    );
  });

  it("requires the error body on any other status, and returns null for it", async () => {
    const { expectContract } = await import("./contract.testkit.js");
    expect(await expectContract("GET", `${BASE}/api/auth/me`, json({ error: "UNAUTHENTICATED" }, 401))).toBeNull();
    await expect(expectContract("GET", `${BASE}/api/auth/me`, json({ error: "nope" }, 401))).rejects.toThrow(/apiError/);
    await expect(expectContract("GET", `${BASE}/api/no/such`, json({ message: "Not found" }, 404))).rejects.toThrow(
      /apiError/,
    );
  });

  it("checks the EXPORTED schema too, not only zod", async () => {
    // A committed http.schema.json that demands a field the zod schema does not know: only the
    // Ajv half of the helper can refuse the answer.
    const real = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...real,
      readFileSync: (path: string, encoding: BufferEncoding) => {
        const text = real.readFileSync(path, encoding);
        if (!String(path).endsWith("http.schema.json")) return text;
        const schema = JSON.parse(text) as {
          definitions: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
        };
        const me = schema.definitions["meResponse"]!;
        me.properties = { ...me.properties, ghost: { type: "string" } };
        me.required = ["user", "ghost"];
        return JSON.stringify(schema);
      },
    }));
    const { expectContract } = await import("./contract.testkit.js");
    await expect(expectContract("GET", `${BASE}/api/auth/me`, json({ user }))).rejects.toThrow(
      /exported schema refuses the answer as meResponse/,
    );
  });

  it("ignores paths outside /api and /healthz", async () => {
    const { expectContract } = await import("./contract.testkit.js");
    expect(await expectContract("GET", `${BASE}/r/ABCD2345`, new Response("<html>", { status: 200 }))).toBeNull();
  });
});
