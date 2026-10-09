import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

/**
 * Each job under `jobs:` and its timeout-minutes, or null when it has none.
 *
 * A line reader rather than a YAML parser, so this needs no dependency: a job is a two space key
 * under `jobs:`, and its timeout is a four space `timeout-minutes:` before the next job. That is
 * the only shape these workflows use, and a job written another way reads as missing its
 * timeout, which fails loudly rather than passing.
 */
function jobTimeouts(source) {
  const jobs = new Map();
  let inJobs = false;
  let current = null;
  for (const line of source.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break;
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      current = job[1];
      jobs.set(current, null);
      continue;
    }
    const timeout = /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(line);
    if (timeout && current) jobs.set(current, Number(timeout[1]));
  }
  return jobs;
}

describe("CI workflows", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  it("finds the workflows and their jobs", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(jobTimeouts(readFileSync(join(WORKFLOWS, file), "utf8")).size).toBeGreaterThan(0);
    }
  });

  // GitHub's default is six hours. A test or mutant that hangs with no limit holds a runner for
  // all of it, which on a private repository is billed and on any repository delays every other
  // run. The limit is the ceiling on what a hang can cost.
  it("gives every job a timeout-minutes of at most an hour", () => {
    for (const file of files) {
      for (const [job, minutes] of jobTimeouts(readFileSync(join(WORKFLOWS, file), "utf8"))) {
        expect({ file, job, minutes }).toEqual({ file, job, minutes: expect.any(Number) });
        expect(minutes, `${file} ${job}`).toBeLessThanOrEqual(60);
      }
    }
  });

  it("reads a job with no timeout as missing, so the guard cannot pass on a parse miss", () => {
    const jobs = jobTimeouts("jobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n  b:\n    runs-on: x\n");
    expect(jobs.get("a")).toBe(5);
    expect(jobs.get("b")).toBeNull();
  });
});
