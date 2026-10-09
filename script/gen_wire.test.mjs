// What the generated files under shared/wire/ SAY, as opposed to whether they are current (which
// check_wire.test.mjs proves). The iOS app is built from these files, so a limit or an enum the
// export drops is a rule the Swift side never hears about. Each test here names a fact the zod
// schemas enforce and looks for it in the export.
//
// Reads the GENERATED text, not the committed files, so these hold for what `npm run gen:wire`
// would write; check:wire separately proves the committed files equal it.

import Ajv from "ajv";
import { beforeAll, describe, expect, it } from "vitest";
import { generateWireFiles, loadShared } from "./gen_wire.mjs";

let shared;
let ws;
let http;
let constants;

beforeAll(async () => {
  shared = await loadShared();
  const files = await generateWireFiles();
  ws = JSON.parse(files["schema.json"]);
  http = JSON.parse(files["http.schema.json"]);
  constants = JSON.parse(files["constants.json"]);
});

/** Follows a JSON pointer, resolving any $ref met on the way, within one document. */
function at(document, pointer) {
  let node = document;
  for (const part of pointer.split("/").slice(1)) {
    node = node?.[part];
    while (node && typeof node.$ref === "string") node = at(document, node.$ref.slice(1));
  }
  return node;
}

/** The member of a discriminated union whose `t` is the given literal. */
function memberOf(document, union, t) {
  const found = document.definitions[union].anyOf.find((option) => option.properties.t.const === t);
  if (!found) throw new Error(`${union} has no member ${t}`);
  return found;
}

/** The schema of one property of a union member, with references resolved. */
function field(document, union, t, ...path) {
  let node = memberOf(document, union, t);
  for (const key of path) {
    while (node && typeof node.$ref === "string") node = at(document, node.$ref.slice(1));
    if (node?.anyOf && key === "*nonNull") {
      node = node.anyOf.find((option) => option.type !== "null");
      continue;
    }
    node = key === "*items" ? node.items : node.properties[key];
  }
  while (node && typeof node.$ref === "string") node = at(document, node.$ref.slice(1));
  return node;
}

function strictAjv() {
  // strict: true turns on every strict option (unknown keywords and formats, strictTypes,
  // strictTuples, strictRequired), and a strict warning is made an error here, not a log line.
  return new Ajv({
    strict: true,
    allErrors: true,
    logger: { log() {}, warn(message) { throw new Error(String(message)); }, error(message) { throw new Error(String(message)); } },
  });
}

describe("Ajv strict mode", () => {
  it("compiles the WebSocket schema", () => {
    const ajv = strictAjv();
    ajv.addSchema(ws, "ws");
    for (const name of Object.keys(ws.definitions)) {
      expect(() => ajv.getSchema(`ws#/definitions/${name}`), name).not.toThrow();
    }
  });

  it("compiles the HTTP schema", () => {
    const ajv = strictAjv();
    ajv.addSchema(http, "http");
    for (const name of Object.keys(http.definitions)) {
      expect(() => ajv.getSchema(`http#/definitions/${name}`), name).not.toThrow();
    }
  });

  it("would refuse the old top level protocolVersion keyword, so the test above can fail", () => {
    const ajv = strictAjv();
    expect(() => ajv.compile({ ...ws, protocolVersion: 2 })).toThrow(/protocolVersion/);
  });
});

describe("dialects", () => {
  const codes = () => [...shared.DIALECT_CODES];

  it("export as an enum of every dialect code", () => {
    expect(ws.definitions.dialectCode).toEqual({ type: "string", enum: codes() });
  });

  it.each([
    ["member.dialect", "peer.joined", ["peer", "dialect"]],
    ["srcDialect", "transcript.final", ["line", "srcDialect"]],
    ["peer.updated's dialect", "peer.updated", ["dialect"]],
    ["translation.result's targetDialect", "translation.result", ["targetDialect"]],
    ["a server glossary entry's sourceDialect", "glossary.updated", ["entries", "*items", "sourceDialect"]],
  ])("%s, which the server sends, is the enum", (_name, t, path) => {
    expect(field(ws, "serverMessage", t, ...path)?.enum).toEqual(codes());
  });

  it.each([
    ["room.create", ["dialect"]],
    ["room.join", ["dialect"]],
    ["member.update", ["dialect"]],
    ["glossary.import", ["entries", "*items", "targetDialect"]],
  ])("%s's dialect, which a client sends, is the enum", (t, path) => {
    expect(field(ws, "clientMessage", t, ...path)?.enum).toEqual(codes());
  });

  it("is the enum in the account API's preferences too", () => {
    const dialect = at(http, "/definitions/preferences/properties/dialect");
    const nonNull = dialect.anyOf?.find((option) => option.type !== "null") ?? dialect;
    const resolved = nonNull.$ref ? at(http, nonNull.$ref.slice(1)) : nonNull;
    expect(resolved.enum).toEqual(codes());
  });
});

describe("text limits", () => {
  const L = () => shared.LIMITS;

  it.each([
    ["username", "clientMessage", "room.create", ["username"], "username"],
    ["a transcript", "clientMessage", "stt.final", ["text"], "transcript"],
    ["an interim transcript", "clientMessage", "stt.interim", ["text"], "transcript"],
    ["chat", "clientMessage", "chat.send", ["text"], "chat"],
    ["a correction", "clientMessage", "glossary.correct", ["correctedTranslation"], "glossaryTranslation"],
    ["an imported glossary term", "clientMessage", "glossary.import", ["entries", "*items", "source"], "glossaryTerm"],
    [
      "an imported glossary translation",
      "clientMessage",
      "glossary.import",
      ["entries", "*items", "target"],
      "glossaryTranslation",
    ],
    ["the import's entry count", "clientMessage", "glossary.import", ["entries"], "glossaryEntries"],
  ])("%s carries its limit", (_name, union, t, path, limit) => {
    const node = field(ws, union, t, ...path);
    const bound = limit === "glossaryEntries" ? node.maxItems : node.maxLength;
    expect(bound).toBe(L()[limit]);
  });

  it("says how the server measures, since maxLength counts code points and the server UTF-16 units", () => {
    const node = field(ws, "clientMessage", "stt.final", "text");
    expect(node.description).toMatch(/UTF-16/);
    expect(node.description).toMatch(/code point/);
  });

  it("publishes what the server really sends for a glossary entry's source: a whole line", () => {
    expect(field(ws, "serverMessage", "glossary.updated", "entries", "*items", "source").maxLength).toBe(
      L().transcript,
    );
    expect(field(ws, "serverMessage", "glossary.updated", "entries", "*items", "target").maxLength).toBe(
      L().glossaryTranslation,
    );
    expect(field(ws, "serverMessage", "room.joined", "snapshot", "glossary", "*items", "source").maxLength).toBe(
      L().transcript,
    );
  });

  it("keeps the client's 200 and 400 on the stored glossary", () => {
    const entry = at(http, "/definitions/glossaryDocument/properties/entries/items");
    expect(at(http, "/definitions/glossaryDocument/properties/entries").maxItems).toBe(L().glossaryEntries);
    expect(entry.properties.source.maxLength).toBe(L().glossaryTerm);
    expect(entry.properties.target.maxLength).toBe(L().glossaryTranslation);
    // A stored entry refuses a term or translation that is empty once cleaned; the room's does not.
    expect(entry.properties.source.minLength).toBe(1);
    expect(entry.properties.target.minLength).toBe(1);
  });

  it("carries the account API's own limits", () => {
    expect(at(http, "/definitions/signupRequest/properties/displayName").maxLength).toBe(L().username);
    expect(at(http, "/definitions/signupRequest/properties/password").maxLength).toBe(shared.MAX_PASSWORD_LENGTH);
    expect(at(http, "/definitions/signupRequest/properties/email").maxLength).toBe(shared.MAX_EMAIL_LENGTH);
  });
});

describe("versions", () => {
  it("are carried in each schema as a const definition, not a nonstandard keyword", () => {
    expect(ws.protocolVersion).toBeUndefined();
    expect(ws.definitions.protocolVersion.const).toBe(shared.PROTOCOL_VERSION);
    expect(http.definitions.apiVersion.const).toBe(shared.API_VERSION);
  });

  it("and in constants.json", () => {
    expect(constants.PROTOCOL_VERSION).toBe(shared.PROTOCOL_VERSION);
    expect(constants.API_VERSION).toBe(shared.API_VERSION);
  });
});

describe("constants.json", () => {
  it("carries every wire constant the app needs, with the values the server uses", () => {
    expect(constants.WS_PATH).toBe(shared.WS_PATH);
    expect(constants.WS_SUBPROTOCOL).toBe(shared.WS_SUBPROTOCOL);
    expect(constants.WS_BEARER_PREFIX).toBe(shared.WS_BEARER_PREFIX);
    expect(constants.CLOSE).toEqual(shared.CLOSE);
    expect(constants.LIMITS).toEqual(shared.LIMITS);
    expect(constants.DIALECT_CODES).toEqual([...shared.DIALECT_CODES]);
    expect(new RegExp(constants.ROOM_CODE_PATTERN).source).toBe(shared.ROOM_CODE_PATTERN.source);
    expect(constants.MIN_PASSWORD_LENGTH).toBe(shared.MIN_PASSWORD_LENGTH);
  });

  it("lists every HTTP route with its method, path, status and schemas", () => {
    expect(constants.HTTP_ROUTES).toEqual(JSON.parse(JSON.stringify(shared.HTTP_ROUTES)));
    for (const route of constants.HTTP_ROUTES) {
      for (const name of [route.request?.schema, route.response].filter(Boolean)) {
        expect(http.definitions, `${route.id}: ${name}`).toHaveProperty(name);
      }
    }
  });
});
