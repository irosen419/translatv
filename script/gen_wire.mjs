#!/usr/bin/env node
// Writes the generated half of shared/wire/, the contract the iOS app's hand written Swift is
// checked against (docs/PLAN.md, D7):
//
//   schema.json       a JSON Schema for every message on the WebSocket, both ways;
//   http.schema.json  a JSON Schema for every request and response body of the HTTP account API,
//                     and /healthz, named as shared/src/http.ts names them;
//   constants.json    the wire constants a client needs and cannot read from a schema: both
//                     versions, the socket's path, subprotocol and bearer prefix, the close codes,
//                     the limits, the dialect codes, and the HTTP route table.
//
// Why it exists: a hand copy that nothing checks is forbidden. The schemas and the golden fixtures
// beside them are what the Swift side is checked against, read in place from shared/wire/ so there
// is no second copy to drift.
//
// Every schema compiles under Ajv's strict mode (script/gen_wire.test.mjs proves it), so nothing
// nonstandard sits in them: the versions are `const` definitions, not extra top level keywords.
//
// Generated from the BUILT shared package (shared/dist), not the TypeScript source, so this runs on
// plain Node with no loader. Run `npm run build:shared` first; `npm run gen:wire` does both.
//
// Deterministic by construction: object keys are sorted at every depth, arrays keep their source
// order (which is the order the union members and required fields are declared in), 2 space
// indent, one trailing newline. That is what lets check_wire.mjs compare the committed files to a
// fresh generation byte for byte instead of structurally.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..");
export const WIRE = join(REPO, "shared", "wire");
const SHARED_DIST = join(REPO, "shared", "dist", "index.js");

/** The built shared package. Fails with the fix spelled out, not a module resolution trace. */
export async function loadShared() {
  if (!existsSync(SHARED_DIST)) {
    throw new Error(`${SHARED_DIST} does not exist. Run \`npm run build:shared\` first.`);
  }
  return import(pathToFileURL(SHARED_DIST).href);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

const OPTIONS = {
  target: "jsonSchema7",
  // A transform's INPUT is what travels on the wire; the output is only what the server holds
  // after cleaning it.
  effectStrategy: "input",
  // A text limit is written as clean().pipe(z.string().max(n)), so the limit lives on the pipe's
  // OUTPUT. Exporting the output is what puts maxLength in the schema; the input side of those
  // pipes is a plain string, and the field's description says how the server measures.
  pipeStrategy: "output",
  // zod STRIPS unknown keys rather than refusing them, so a frame carrying a field this version
  // does not know is still valid. Saying additionalProperties: false would make the schema
  // stricter than the parser it describes. A .strict() object still says false.
  removeAdditionalStrategy: "strict",
};

function text(document) {
  return JSON.stringify(sortKeys(document), null, 2) + "\n";
}

/** A version as a schema: standard JSON Schema, which Ajv's strict mode accepts. */
function versionDefinition(value, description) {
  return { type: "integer", const: value, description };
}

/** The WebSocket schema document. */
function wsSchema(shared) {
  // Named so a reader of the schema (and of any Swift written from it) sees one Member, one
  // RenderedLine, one code enum, referenced wherever it is used, rather than the same shape
  // inlined a dozen times with nothing saying the copies are the same type.
  const named = {
    dialectCode: shared.dialectCode,
    roomCode: shared.roomCode,
    username: shared.username,
    glossaryEntry: shared.glossaryEntry,
    serverGlossaryEntry: shared.serverGlossaryEntry,
    errorCode: shared.errorCode,
    translationFailureCode: shared.translationFailureCode,
    translationStatus: shared.translationStatus,
    skipReason: shared.skipReason,
    rtcIceServerConfig: shared.rtcIceServerConfig,
    member: shared.member,
    renderedLine: shared.renderedLine,
  };

  const definitions = {};
  for (const name of ["clientMessage", "serverMessage"]) {
    const part = zodToJsonSchema(shared[name], { ...OPTIONS, name, definitions: named });
    for (const [key, schema] of Object.entries(part.definitions)) {
      const sorted = JSON.stringify(sortKeys(schema));
      if (key in definitions && JSON.stringify(definitions[key]) !== sorted) {
        throw new Error(`definition ${key} generated differently for ${name}`);
      }
      definitions[key] = sortKeys(schema);
    }
  }
  definitions.protocolVersion = versionDefinition(
    shared.PROTOCOL_VERSION,
    "PROTOCOL_VERSION: the wire format this schema describes. /healthz serves the server's as protocolVersion.",
  );

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Translatv WebSocket wire protocol",
    description:
      "GENERATED by script/gen_wire.mjs from shared/src/protocol.ts. Do not edit by hand. " +
      "Every frame is a JSON object discriminated on `t`: clientMessage is what a client sends, " +
      "serverMessage is what the server sends. The version is definitions.protocolVersion.",
    definitions,
  };
}

/** The HTTP schema document: every schema a route in HTTP_ROUTES names, under that name. */
function httpSchema(shared) {
  const named = {
    dialectCode: shared.dialectCode,
    username: shared.username,
    storedGlossaryEntry: shared.storedGlossaryEntry,
    publicUser: shared.publicUser,
    apiErrorCode: shared.apiErrorCode,
    signupMode: shared.signupMode,
    callPeer: shared.callPeer,
    callRecord: shared.callRecord,
    contact: shared.contact,
    ...shared.HTTP_SCHEMAS,
  };
  // Every name in `definitions` is emitted whether or not the root uses it, so the root is only a
  // carrier and is dropped.
  const { definitions } = zodToJsonSchema(shared.HTTP_SCHEMAS.apiError, { ...OPTIONS, definitions: named });
  definitions.apiVersion = versionDefinition(
    shared.API_VERSION,
    "API_VERSION: the HTTP account API this schema describes. /healthz serves the server's as apiVersion.",
  );
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Translatv HTTP account API",
    description:
      "GENERATED by script/gen_wire.mjs from shared/src/http.ts, auth.ts and account.ts. Do not " +
      "edit by hand. Each route's request and response schema is named in HTTP_ROUTES in " +
      "constants.json; every non success answer under /api is apiError. callsQuery is a query " +
      "string, not a body. The version is definitions.apiVersion.",
    definitions,
  };
}

/** The constants a client needs that no schema can carry. Keys are the TypeScript names. */
function constants(shared) {
  return {
    $comment: "GENERATED by script/gen_wire.mjs from shared/src. Do not edit by hand.",
    PROTOCOL_VERSION: shared.PROTOCOL_VERSION,
    API_VERSION: shared.API_VERSION,
    WS_PATH: shared.WS_PATH,
    WS_SUBPROTOCOL: shared.WS_SUBPROTOCOL,
    WS_BEARER_PREFIX: shared.WS_BEARER_PREFIX,
    CLOSE: shared.CLOSE,
    LIMITS: shared.LIMITS,
    ROOM_CODE_PATTERN: shared.ROOM_CODE_PATTERN.source,
    DIALECT_CODES: [...shared.DIALECT_CODES],
    MIN_PASSWORD_LENGTH: shared.MIN_PASSWORD_LENGTH,
    MAX_PASSWORD_LENGTH: shared.MAX_PASSWORD_LENGTH,
    MAX_EMAIL_LENGTH: shared.MAX_EMAIL_LENGTH,
    CALLS_PAGE_DEFAULT: shared.CALLS_PAGE_DEFAULT,
    CALLS_PAGE_MAX: shared.CALLS_PAGE_MAX,
    HTTP_ROUTES: shared.HTTP_ROUTES,
  };
}

/** The generated files, by name, as the exact text that belongs in shared/wire/. */
export async function generateWireFiles() {
  const shared = await loadShared();
  return {
    "schema.json": text(wsSchema(shared)),
    "http.schema.json": text(httpSchema(shared)),
    "constants.json": text(constants(shared)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(WIRE, { recursive: true });
  for (const [name, content] of Object.entries(await generateWireFiles())) {
    writeFileSync(join(WIRE, name), content, "utf8");
    console.log(`wrote ${join("shared", "wire", name)}`);
  }
}
