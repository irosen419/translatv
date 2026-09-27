import { describe, expect, it } from "vitest";
import {
  floorSummary,
  measured,
  percentile,
  renderTable,
  summarize,
  unmeasured,
} from "./latency_stats.mjs";

describe("percentile", () => {
  it("uses nearest rank, so every reported value is a value that was actually observed", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 90)).toBe(9);
    expect(percentile(values, 100)).toBe(10);
  });

  it("does not care what order the samples arrive in", () => {
    expect(percentile([9, 1, 5, 3, 7], 50)).toBe(5);
  });

  it("returns the only sample for every percentile when there is one sample", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 90)).toBe(42);
  });

  it("returns null for no samples, never zero", () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe("summarize", () => {
  it("returns null for no samples rather than a row of zeros", () => {
    // The ledger's rule, transposed: an unrecoverable value is null, never zero. A zero here
    // would render as "0.0 ms" and read as a stage that is instant rather than one nobody timed.
    expect(summarize([])).toBeNull();
  });

  it("carries the sample count, so a one sample p90 is visibly not a distribution", () => {
    expect(summarize([7]))
      .toMatchObject({ count: 1, p50: 7, p90: 7, max: 7 });
  });

  it("reports p50, p90, max and min over real samples", () => {
    const stats = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(stats).toMatchObject({ count: 10, p50: 50, p90: 90, max: 100, min: 10 });
  });
});

describe("measured", () => {
  it("degrades to an unmeasured row when it is handed no samples", () => {
    // Defensive, and load bearing. A stage whose collection silently produced nothing must not
    // render as a measurement of zero: it has to say that nobody timed it.
    const row = measured("render", []);
    expect(row.kind).toBe("unmeasured");
    expect(row.reason).toContain("no samples");
  });

  it("keeps the stats and the name on a real measurement", () => {
    const row = measured("render", [3, 4, 5]);
    expect(row.kind).toBe("measured");
    expect(row.name).toBe("render");
    expect(row.stats.count).toBe(3);
  });
});

describe("renderTable", () => {
  it("prints the word unmeasured and its reason, never a zero", () => {
    const text = renderTable([unmeasured("recognition", "no audio hardware in a container")]);
    expect(text).toContain("unmeasured");
    expect(text).toContain("no audio hardware in a container");
    expect(text).not.toMatch(/\b0\.0\b/);
  });

  it("prints the sample count beside every measured stage", () => {
    const text = renderTable([measured("translation", [1.5, 2.5, 3.5])]);
    expect(text).toContain("translation");
    expect(text).toMatch(/\bn=3\b/);
  });

  it("marks a diagnostic row so it cannot be read as part of the critical path", () => {
    const text = renderTable([measured("socket round trip", [2], { path: false })]);
    expect(text).toContain("diagnostic");
  });
});

describe("floorSummary", () => {
  it("sums only critical path stages, so a nested diagnostic cannot be double counted", () => {
    const rows = [
      measured("uplink", [10]),
      measured("translation", [20]),
      // A span that CONTAINS the two above. Summing it as well would report 60 ms for a
      // pipeline that takes 30.
      measured("send to result, whole loop", [30], { path: false }),
    ];
    expect(floorSummary(rows).knownMs).toBe(30);
  });

  it("is a floor whenever any critical path stage is unmeasured", () => {
    const rows = [
      measured("translation", [20]),
      unmeasured("recognition", "needs real speech on real hardware"),
    ];
    const summary = floorSummary(rows);
    expect(summary.isFloor).toBe(true);
    expect(summary.unmeasuredStages).toBe(1);
    expect(summary.measuredStages).toBe(1);
  });

  it("is not a floor once every critical path stage has a number", () => {
    const summary = floorSummary([measured("a", [1]), measured("b", [2])]);
    expect(summary.isFloor).toBe(false);
    expect(summary.unmeasuredStages).toBe(0);
    expect(summary.knownMs).toBe(3);
  });

  it("says a total is a floor rather than reporting it as precise", () => {
    const text = renderTable([
      measured("translation", [20]),
      unmeasured("recognition", "needs real hardware"),
    ]);
    expect(text).toContain("floor");
  });
});
