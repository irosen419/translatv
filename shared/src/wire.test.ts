// The golden fixtures under shared/wire/ are the contract a second implementation of this protocol
// (the Swift one, D7 in docs/PLAN.md) is checked against. They are only worth that if every one of
// them is something THESE schemas accept, and if no message type is missing one, because a type
// with no fixture is a type the other side is never tested on.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { HTTP_FIXTURES, HTTP_SCHEMAS } from "./http.js";
import { clientMessage, PROTOCOL_VERSION, serverMessage } from "./protocol.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "wire", "fixtures");

type Union = typeof clientMessage | typeof serverMessage;

function typesOf(union: Union): string[] {
  return union.options.map((option: z.AnyZodObject) => option.shape.t.value as string).sort();
}

function fixtureNames(side: "client" | "server"): string[] {
  return readdirSync(join(FIXTURES, side))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

function readFixture(side: "client" | "server", t: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, side, `${t}.json`), "utf8"));
}

const SIDES = [
  ["client", clientMessage],
  ["server", serverMessage],
] as const;

describe("PROTOCOL_VERSION", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe.each(SIDES)("%s fixtures", (side, union) => {
  it("exist for every member of the union, and for nothing else", () => {
    expect(fixtureNames(side)).toEqual(typesOf(union));
  });

  it("are listed in index.json exactly as they are on disk", () => {
    const index = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8")) as Record<string, string[]>;
    expect([...(index[side] ?? [])].sort()).toEqual(fixtureNames(side));
  });

  it.each(typesOf(union))("%s parses, carries its own t, and is already canonical", (t) => {
    const fixture = readFixture(side, t);
    const parsed = union.safeParse(fixture);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    expect((fixture as { t: string }).t).toBe(t);
    // Parsing strips unknown keys and applies the text transforms. A fixture that changes under
    // parsing is one whose bytes a round trip test on the other side could never reproduce, and
    // an unknown key in it is almost always a typo that the schema silently dropped.
    expect(parsed.success && parsed.data).toEqual(fixture);
  });
});

// The account API's fixtures: one per request body or query and one per response body, named
// <route id>.<request|response>.json, plus the error body. HTTP_FIXTURES derives the list from
// HTTP_ROUTES, so a route added without fixtures fails here.
describe("http fixtures", () => {
  const onDisk = readdirSync(join(FIXTURES, "http"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();

  it("exist for every route's request and response, and for nothing else", () => {
    expect(onDisk).toEqual(HTTP_FIXTURES.map((fixture) => fixture.name).sort());
  });

  it("are listed in index.json exactly as they are on disk", () => {
    const index = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8")) as Record<string, string[]>;
    expect([...(index["http"] ?? [])].sort()).toEqual(onDisk);
  });

  it.each(HTTP_FIXTURES.map((fixture) => [fixture.name, fixture.schema] as const))(
    "%s parses with %s, and is already canonical",
    (name, schema) => {
      const fixture = JSON.parse(readFileSync(join(FIXTURES, "http", `${name}.json`), "utf8")) as unknown;
      const parsed = HTTP_SCHEMAS[schema].safeParse(fixture);
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
      expect(parsed.success && parsed.data).toEqual(fixture);
    },
  );
});
