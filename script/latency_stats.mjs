// Aggregating latency samples into a table that cannot overstate what was measured.
//
// Pure arithmetic, no I/O, no browser, no server. Separated from script/latency.mjs so the part
// that decides whether a printed number is a measurement or a fiction is unit tested, while the
// part that drives browsers stays an on demand script.
//
// The honesty rules here are the spend ledger's, transposed from money to milliseconds, and each
// one exists for the same reason it does there:
//
//   1. A stage with no samples is NULL, never zero. "Nobody timed this" and "this takes no time"
//      are different facts, and a zero renders as "0.0 ms" and quietly becomes the second one.
//      Recognition latency is the live case: it cannot be measured in a container at all.
//   2. A total is reported as a FLOOR whenever any critical path stage is unmeasured, alongside a
//      count of how many are missing, exactly as the ledger reports known_usd beside
//      unparsed_rows. A partial total presented as a precise one is how a benchmark lies.
//   3. Only critical path stages sum into the total. A span that CONTAINS other spans is marked
//      diagnostic and excluded, because summing a whole loop together with its own parts reports
//      a pipeline as twice as slow as it is.
//   4. The sample count travels with every distribution, so a p90 computed from one sample is
//      visibly not a distribution.
//
// Percentiles are nearest rank, so every number printed is a number that was actually observed
// rather than an interpolation between two samples that never happened.

/**
 * Milliseconds are reported to two decimals.
 *
 * Two rather than one because the stages differ by four orders of magnitude: a ledger append is
 * tens of microseconds and a spend gate check on a long ledger is hundreds of milliseconds. At one
 * decimal the fast end of that range all prints as "0.0 ms", which reads like an unmeasured stage
 * in a table whose whole point is that those are different things.
 */
const MS_PRECISION = 2;

function roundMs(value) {
  const factor = 10 ** MS_PRECISION;
  return Math.round(value * factor) / factor;
}

function formatMs(value) {
  return `${value.toFixed(MS_PRECISION)} ms`;
}

/**
 * The nearest rank percentile of a sample set, or null when there are no samples.
 *
 * Null rather than 0 for the empty case, for rule 1 above. Callers that render this must handle
 * the null; that is the point of returning it.
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * A sample set's distribution, or null when it is empty.
 *
 * count is part of the shape rather than an extra, because a summary without it invites reading
 * a single observation as a percentile.
 */
export function summarize(samples) {
  if (samples.length === 0) return null;
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    count: samples.length,
    min: percentile(samples, 0),
    p50: percentile(samples, 50),
    p90: percentile(samples, 90),
    max: percentile(samples, 100),
    mean: roundMs(total / samples.length),
  };
}

/**
 * A measured stage.
 *
 * Handed an empty sample set it returns an UNMEASURED row rather than a row of zeros. That is
 * defensive and load bearing: a collection step that silently produced nothing (a frame that
 * never arrived, a selector that never matched) must not be indistinguishable from a stage that
 * genuinely takes no time.
 *
 * path false marks a diagnostic span: one that contains other spans, or that is context rather
 * than a segment of the pipeline. Diagnostic rows are printed and never summed.
 */
export function measured(name, samples, options = {}) {
  const { path = true, note = "" } = options;
  const stats = summarize(samples);
  if (stats === null) {
    return unmeasured(name, "no samples were collected for this stage", { path });
  }
  return { kind: "measured", name, stats, path, note };
}

/** A stage nobody could time, with the reason why. Never rendered as a number. */
export function unmeasured(name, reason, options = {}) {
  const { path = true } = options;
  return { kind: "unmeasured", name, reason, path };
}

/**
 * The measured total, and whether it is a floor.
 *
 * knownMs sums the p50 of every critical path stage that has one. isFloor is true when any
 * critical path stage is unmeasured, which means the real end to end figure is larger than
 * knownMs by an amount this run cannot state.
 */
export function floorSummary(rows) {
  const pathRows = rows.filter((row) => row.path);
  const measuredRows = pathRows.filter((row) => row.kind === "measured");
  const knownMs = roundMs(measuredRows.reduce((sum, row) => sum + row.stats.p50, 0));
  const unmeasuredStages = pathRows.length - measuredRows.length;
  return {
    knownMs,
    measuredStages: measuredRows.length,
    unmeasuredStages,
    pathStages: pathRows.length,
    isFloor: unmeasuredStages > 0,
  };
}

function cells(row) {
  const label = row.path ? row.name : `${row.name} (diagnostic)`;
  if (row.kind === "unmeasured") {
    return [label, "unmeasured", "", "", row.reason];
  }
  const detail = row.note ? `n=${row.stats.count}, ${row.note}` : `n=${row.stats.count}`;
  return [
    label,
    formatMs(row.stats.p50),
    formatMs(row.stats.p90),
    formatMs(row.stats.max),
    detail,
  ];
}

/**
 * Render the stage table plus its verdict line.
 *
 * Markdown, because its destination is a proposal document as well as a terminal, and a table
 * that has to be reformatted by hand to be committed will be.
 */
export function renderTable(rows) {
  const header = ["stage", "p50", "p90", "max", "samples"];
  const lines = [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${cells(row).join(" | ")} |`),
  ];

  const summary = floorSummary(rows);
  lines.push("");
  if (summary.measuredStages === 0) {
    // Deliberately not "0.0 ms". No stage was timed, so there is no total, and printing one
    // would be inventing a measurement out of the absence of measurements.
    lines.push(
      `No critical path stage was measured. ${summary.unmeasuredStages} of ` +
        `${summary.pathStages} are unmeasured, so this run reports no end to end figure.`,
    );
  } else if (summary.isFloor) {
    lines.push(
      `Measured floor ${formatMs(summary.knownMs)} across ${summary.measuredStages} of ` +
        `${summary.pathStages} critical path stages. ${summary.unmeasuredStages} unmeasured, ` +
        `so the real end to end time is LARGER than this by an amount this run cannot state.`,
    );
  } else {
    lines.push(
      `Measured end to end ${formatMs(summary.knownMs)} across all ` +
        `${summary.pathStages} critical path stages.`,
    );
  }

  return lines.join("\n");
}
