import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

// The ceiling on any one job. GitHub's own default is six hours.
const MAX_MINUTES = 60;

/**
 * What is wrong with a workflow's job timeouts, as one line per problem. Empty means every job
 * has a timeout-minutes that is a whole number from 1 to MAX_MINUTES.
 *
 * A real YAML parser, not a line reader. Review found the first version, which matched job names
 * by their indent, skipping jobs written in other valid shapes: a comment line between jobs, a
 * comment after the job name, a quoted name, an anchor, a flow style job. Each one passed with its
 * timeout missing. A parser sees the jobs GitHub sees.
 *
 * A job that calls a reusable workflow (`uses:`) is exempt and must NOT carry timeout-minutes:
 * GitHub does not allow the key there, and the called workflow's own jobs carry the limit. An
 * expression (`${{ ... }}`) is refused: nothing here can check its value against the ceiling.
 */
function timeoutProblems(source) {
  const workflow = parse(source);
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== "object" || Object.keys(jobs).length === 0) return ["no jobs found"];
  const problems = [];
  for (const [name, job] of Object.entries(jobs)) {
    const minutes = job?.["timeout-minutes"];
    if (job && typeof job === "object" && "uses" in job) {
      if (minutes !== undefined) problems.push(`${name}: a reusable workflow call cannot set timeout-minutes`);
      continue;
    }
    if (minutes === undefined) problems.push(`${name}: no timeout-minutes`);
    else if (!Number.isInteger(minutes)) problems.push(`${name}: timeout-minutes must be a whole number, got ${JSON.stringify(minutes)}`);
    else if (minutes < 1 || minutes > MAX_MINUTES) problems.push(`${name}: timeout-minutes must be 1 to ${MAX_MINUTES}, got ${minutes}`);
  }
  return problems;
}

describe("CI workflows", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  it("finds the workflows", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // GitHub's default is six hours. A test or mutant that hangs with no limit holds a runner for
  // all of it, which on a private repository is billed and on any repository delays every other
  // run. The limit is the ceiling on what a hang can cost.
  it(`gives every job a timeout-minutes from 1 to ${MAX_MINUTES}`, () => {
    for (const file of files) {
      expect(timeoutProblems(readFileSync(join(WORKFLOWS, file), "utf8")), file).toEqual([]);
    }
  });
});

describe("the timeout guard itself", () => {
  const ok = "    runs-on: x\n    timeout-minutes: 5\n";
  const bare = "    runs-on: x\n";

  // Each of these is a valid workflow with a job missing its timeout, or carrying a bad one. The
  // line reader passed the first five.
  it.each([
    ["a comment line between jobs", `jobs:\n  a:\n${ok}# ---- next ----\n  b:\n${bare}`, "b: no timeout-minutes"],
    ["a comment after the job name", `jobs:\n  a:\n${ok}  b: # browsers\n${bare}`, "b: no timeout-minutes"],
    ["a quoted job name", `jobs:\n  a:\n${ok}  "b":\n${bare}`, "b: no timeout-minutes"],
    ["an anchor on the job", `jobs:\n  a:\n${ok}  b: &b\n${bare}`, "b: no timeout-minutes"],
    ["a flow style job", `jobs:\n  a:\n${ok}  b: { runs-on: x }\n`, "b: no timeout-minutes"],
    ["a zero timeout", "jobs:\n  a:\n    runs-on: x\n    timeout-minutes: 0\n", "a: timeout-minutes must be 1 to 60, got 0"],
    ["a negative timeout", "jobs:\n  a:\n    runs-on: x\n    timeout-minutes: -5\n", "a: timeout-minutes must be 1 to 60, got -5"],
    ["a timeout over the ceiling", "jobs:\n  a:\n    runs-on: x\n    timeout-minutes: 61\n", "a: timeout-minutes must be 1 to 60, got 61"],
    ["a quoted timeout", 'jobs:\n  a:\n    runs-on: x\n    timeout-minutes: "10"\n', 'a: timeout-minutes must be a whole number, got "10"'],
    ["an expression timeout", "jobs:\n  a:\n    runs-on: x\n    timeout-minutes: ${{ matrix.t }}\n", 'a: timeout-minutes must be a whole number, got "${{ matrix.t }}"'],
    ["the timeout on a step", "jobs:\n  a:\n    runs-on: x\n    steps:\n      - run: x\n        timeout-minutes: 5\n", "a: no timeout-minutes"],
    ["a timeout on a reusable workflow call", "jobs:\n  a:\n    uses: ./.github/workflows/x.yml\n    timeout-minutes: 5\n", "a: a reusable workflow call cannot set timeout-minutes"],
    ["no jobs at all", "on: push\n", "no jobs found"],
  ])("refuses %s", (_label, source, problem) => {
    expect(timeoutProblems(source)).toContain(problem);
  });

  // Valid workflows that are fine as they are. A guard that fails on these gets deleted rather
  // than understood.
  it.each([
    ["a comment after the timeout", "jobs:\n  a:\n    runs-on: x\n    timeout-minutes: 10 # ceiling\n"],
    ["a comment after jobs:", `jobs: # all\n  a:\n${ok}`],
    ["a four space indent", "jobs:\n    a:\n        runs-on: x\n        timeout-minutes: 5\n"],
    ["a reusable workflow call with no timeout", "jobs:\n  a:\n    uses: ./.github/workflows/x.yml\n"],
    ["a matrix job", `jobs:\n  a:\n    strategy:\n      matrix:\n        n: [1, 2]\n${ok}`],
    ["CRLF line endings", `jobs:\r\n  a:\r\n    runs-on: x\r\n    timeout-minutes: 5\r\n`],
  ])("accepts %s", (_label, source) => {
    expect(timeoutProblems(source)).toEqual([]);
  });
});
