import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { describeFailure } from "./translate_failure.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("describeFailure", () => {
  it("names the failure code, the status, and whether a retry can help", () => {
    const text = describeFailure({
      ok: false,
      status: "unavailable",
      reason: "PROVIDER_REJECTED",
      retriable: false,
    });
    expect(text).toContain("PROVIDER_REJECTED");
    expect(text).toContain("unavailable");
    expect(text).toContain("terminal");
  });

  it("says retriable for a failure a retry can fix", () => {
    const text = describeFailure({
      ok: false,
      status: "rate_limited",
      reason: "PROVIDER_RATE_LIMITED",
      retriable: true,
    });
    expect(text).toContain("PROVIDER_RATE_LIMITED");
    expect(text).toContain("retriable");
    expect(text).not.toContain("terminal");
  });

  // The bug this exists for: the script printed result.message, a field a failed translation has
  // not carried since failures became codes, so every failure read "Reason: undefined".
  it("never renders undefined, even for a result missing its fields", () => {
    expect(describeFailure({ ok: false })).not.toContain("undefined");
    expect(describeFailure({ ok: false, status: "unavailable" })).not.toContain("undefined");
  });

  // "terminal" is a claim that a retry cannot help. A result that does not say either way gets
  // no such claim: calling it terminal would send someone away from a retry that might work.
  it("says the retry is unknown when the result does not say", () => {
    for (const value of [{ ok: false }, { ok: false, retriable: "true" }, null, undefined]) {
      const text = describeFailure(value);
      expect(text).toContain("retry unknown");
      expect(text).not.toContain("terminal");
      expect(text).not.toContain("retriable,");
    }
  });
});

describe("verify_translation.mjs", () => {
  const SCRIPT = readFileSync(join(HERE, "verify_translation.mjs"), "utf8");

  it("reads .message only off a caught error", () => {
    expect(messageReads(SCRIPT)).toEqual([]);
  });

  // The glossary check said only "call failed", with no reason, under a script whose job here is
  // to say why a translation failed.
  it("never says only that a call failed", () => {
    expect(stringLiterals(SCRIPT)).not.toContain("call failed");
  });
});

describe("the .message guard itself", () => {
  it.each([
    ["a plain read", "smoke.message"],
    ["an optional read", "smoke?.message"],
    ["a bracket read", 'smoke["message"]'],
    ["any variable name", "r.message"],
    ["a read inside a template", "`Reason: ${result.message}`"],
    ["a read after // inside a template", "`see // ${result.message}`"],
    ["a read after a string holding /*", 'const a = "out/*.jsonl"; smoke.message; const b = "*/";'],
    ["a caught error's name used outside its catch", "try {} catch (error) {} error.message;"],
  ])("flags %s", (_label, source) => {
    expect(messageReads(source)).toHaveLength(1);
  });

  it.each([
    ["a caught error", "try { go(); } catch (error) { console.error(error?.message); }"],
    ["a comment naming the old bug", "// This printed result.message once.\n/* and smoke.message */\nok();"],
    ["a string naming it", 'const note = "result.message";'],
  ])("allows %s", (_label, source) => {
    expect(messageReads(source)).toEqual([]);
  });
});

/**
 * Every `.message` read in a script that is not on a caught error. A failed translation RESULT
 * has no message (failures are codes, with the sentence in the client's copy), so a read there
 * prints "undefined"; a thrown Error has one. Read from the syntax tree, so comments and strings
 * are not code, a read inside a template is, and no list of variable names can go stale.
 */
function messageReads(source) {
  const file = ts.createSourceFile("script.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const reads = [];
  const visit = (node, caught) => {
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
      const inner = new Set(caught).add(node.variableDeclaration.name.text);
      ts.forEachChild(node, (child) => visit(child, inner));
      return;
    }
    let target = null;
    if (ts.isPropertyAccessExpression(node) && node.name.text === "message") target = node.expression;
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "message"
    ) {
      target = node.expression;
    }
    if (target && !(ts.isIdentifier(target) && caught.has(target.text))) reads.push(node.getText(file));
    ts.forEachChild(node, (child) => visit(child, caught));
  };
  visit(file, new Set());
  return reads;
}

function stringLiterals(source) {
  const file = ts.createSourceFile("script.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
