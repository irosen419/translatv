// The pure parts of the blind test: reading the set, choosing a balanced subset, building each
// line's context the way production does, the dialect marker checks, and the statistics.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildUserMessage, CONTEXT_TURNS } from "../../translate/prompt.js";
import { contextFor, interleaveByTarget, parseItems, selectBalanced, TARGETS, type BlindItem } from "./items.js";
import { markerCheck } from "./markers.js";
import { mean, pairedBootstrap, percentile, rng, seedFrom, shuffled } from "./stats.js";

const SET = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "eval", "blind", "sentences.jsonl");
const items = parseItems(readFileSync(SET, "utf8"));

function item(overrides: Partial<BlindItem>): BlindItem {
  return { id: "x1", conv: "c1", seq: 1, src: "en-US", tgt: "es-AR", text: "hi", address: "singular", tags: [], ...overrides };
}

describe("the sentence set", () => {
  it("reads all 625 lines, 125 per target", () => {
    expect(items).toHaveLength(625);
    for (const target of TARGETS) expect(items.filter((i) => i.tgt === target)).toHaveLength(125);
  });

  it("refuses a line that is not an item rather than skipping it", () => {
    expect(() => parseItems('{"id":"b1"}\n')).toThrow(/line 1/);
  });
});

describe("a balanced subset", () => {
  it("takes the same number from each target, spread through it rather than its first lines", () => {
    const ten = selectBalanced(items, 10);
    expect(ten).toHaveLength(10);
    for (const target of TARGETS) expect(ten.filter((i) => i.tgt === target)).toHaveLength(2);
    // Spread: not only the opening lines of the first conversations.
    expect(ten.some((i) => i.seq > 1)).toBe(true);
  });

  it("is everything, in file order, without a limit or with one past the set", () => {
    expect(selectBalanced(items, null)).toEqual(items);
    expect(selectBalanced(items, 10_000)).toEqual(items);
  });

  it("gives an uneven limit's remainder to the first targets", () => {
    const seven = selectBalanced(items, 7);
    expect(TARGETS.map((t) => seven.filter((i) => i.tgt === t).length)).toEqual([2, 2, 1, 1, 1]);
  });
});

describe("interleaving by target", () => {
  it("cycles through the five targets, so any prefix is balanced", () => {
    const order = interleaveByTarget(items);
    expect(order).toHaveLength(625);
    expect(order.slice(0, 5).map((i) => i.tgt).sort()).toEqual([...TARGETS].sort());
    const first50 = order.slice(0, 50);
    for (const target of TARGETS) expect(first50.filter((i) => i.tgt === target)).toHaveLength(10);
  });
});

describe("context, as production passes it", () => {
  it("is the earlier lines of the same conversation, at most CONTEXT_TURNS less the line itself", () => {
    // RoomSession keeps the last CONTEXT_TURNS lines including the one being translated, and
    // contextFor drops that one: so at most five earlier lines reach the prompt.
    const conv = items.filter((i) => i.conv === items[0]!.conv);
    expect(contextFor(items, conv[0]!)).toEqual([]);
    const second = contextFor(items, conv[1]!);
    expect(second).toEqual([{ username: "Speaker", dialect: conv[0]!.src, text: conv[0]!.text }]);

    const long: BlindItem[] = Array.from({ length: 8 }, (_, n) => item({ id: `l${n}`, seq: n + 1, text: `line ${n}` }));
    const last = contextFor(long, long[7]!);
    expect(last).toHaveLength(CONTEXT_TURNS - 1);
    expect(last.map((t) => t.text)).toEqual(["line 2", "line 3", "line 4", "line 5", "line 6"]);
  });

  it("never carries a line of another conversation", () => {
    const mixed = [item({ id: "a", conv: "c1", seq: 1, text: "one" }), item({ id: "b", conv: "c2", seq: 1, text: "two" })];
    expect(contextFor(mixed, mixed[1]!)).toEqual([]);
  });

  it("renders through the production user message", () => {
    const conv = items.filter((i) => i.conv === items[0]!.conv);
    const user = buildUserMessage(contextFor(items, conv[1]!), conv[1]!.text);
    expect(user).toContain("<context>");
    expect(user).toContain(conv[0]!.text);
  });
});

describe("dialect marker checks", () => {
  it("passes voseo for es-AR singular, with or without accents, and fails tu forms", () => {
    expect(markerCheck(item({ tgt: "es-AR" }), "Tenés tiempo mañana?").outcome).toBe("pass");
    expect(markerCheck(item({ tgt: "es-AR" }), "Tenes tiempo manana?").outcome).toBe("pass");
    expect(markerCheck(item({ tgt: "es-AR" }), "Vení cuando quieras, decime").outcome).toBe("pass");
    const bad = markerCheck(item({ tgt: "es-AR" }), "¿Tienes tiempo mañana?");
    expect(bad.outcome).toBe("fail");
    expect(bad.found).toContain("tienes");
    expect(markerCheck(item({ tgt: "es-AR" }), "Tú sabés").outcome).toBe("fail");
  });

  it("does not count the possessive tu as tuteo, nor sabes as either", () => {
    // "tu casa" is ordinary Rioplatense, and sabes/sabés differ only by an accent the exemplars drop.
    expect(markerCheck(item({ tgt: "es-AR" }), "Saludos a tu papá").outcome).toBe("inconclusive");
    expect(markerCheck(item({ tgt: "es-AR" }), "sabes que sí").outcome).toBe("inconclusive");
  });

  it("checks es-AR plural for ustedes, never vosotros", () => {
    expect(markerCheck(item({ tgt: "es-AR", address: "plural" }), "Ustedes vienen?").outcome).toBe("pass");
    expect(markerCheck(item({ tgt: "es-AR", address: "plural" }), "Vosotros venís?").outcome).toBe("fail");
  });

  it("passes usted for es-CO singular and fails tu or voseo", () => {
    expect(markerCheck(item({ tgt: "es-CO" }), "¿Usted tiene tiempo mañana?").outcome).toBe("pass");
    expect(markerCheck(item({ tgt: "es-CO" }), "¿Tienes tiempo mañana?").outcome).toBe("fail");
    expect(markerCheck(item({ tgt: "es-CO" }), "¿Vos tenés tiempo?").outcome).toBe("fail");
    // A dropped pronoun hides the register: no claim either way.
    expect(markerCheck(item({ tgt: "es-CO" }), "¿Tiene tiempo mañana?").outcome).toBe("inconclusive");
  });

  it("passes vosotros forms for es-ES plural and fails ustedes", () => {
    expect(markerCheck(item({ tgt: "es-ES", address: "plural" }), "¿Queréis venir?").outcome).toBe("pass");
    expect(markerCheck(item({ tgt: "es-ES", address: "plural" }), "Quereis venir vosotros?").outcome).toBe("pass");
    expect(markerCheck(item({ tgt: "es-ES", address: "plural" }), "¿Ustedes quieren venir?").outcome).toBe("fail");
    // "país" and "seis" end like a vosotros verb and are not one.
    expect(markerCheck(item({ tgt: "es-ES", address: "plural" }), "Seis horas en el país").outcome).toBe("inconclusive");
  });

  it("fails es-MX on any voseo or vosotros, and passes it otherwise", () => {
    expect(markerCheck(item({ tgt: "es-MX" }), "¿Tienes tiempo?").outcome).toBe("pass");
    expect(markerCheck(item({ tgt: "es-MX", address: "plural" }), "¿Queréis venir?").outcome).toBe("fail");
    expect(markerCheck(item({ tgt: "es-MX" }), "¿Vos tenés tiempo?").outcome).toBe("fail");
  });

  it("is not applicable where the address makes it meaningless", () => {
    expect(markerCheck(item({ tgt: "es-AR", address: "none" }), "Tienes").applicable).toBe(false);
    expect(markerCheck(item({ tgt: "es-ES", address: "singular" }), "Tienes").applicable).toBe(false);
    expect(markerCheck(item({ tgt: "en-US" }), "you").applicable).toBe(false);
    expect(markerCheck(item({ tgt: "es-MX", address: "none" }), "Vosotros").applicable).toBe(false);
  });
});

describe("statistics", () => {
  it("is deterministic for a seed, and differs across seeds", () => {
    const a = rng(seedFrom("run-1"));
    const b = rng(seedFrom("run-1"));
    const c = rng(seedFrom("run-2"));
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    for (const value of first) expect(value >= 0 && value < 1).toBe(true);
  });

  it("shuffles without losing or inventing anything", () => {
    const out = shuffled([1, 2, 3, 4, 5], rng(7));
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("takes nearest rank percentiles, and null for no samples", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
    expect(mean([])).toBeNull();
    expect(mean([1, 2])).toBe(1.5);
  });

  it("bootstraps a paired difference whose interval holds the observed mean", () => {
    const diffs = [3, 5, 4, 6, 2, 5, 4, 3, 6, 5];
    const result = pairedBootstrap(diffs, 2000, rng(1));
    expect(result).not.toBeNull();
    expect(result!.mean).toBeCloseTo(4.3, 10);
    expect(result!.low).toBeLessThanOrEqual(4.3);
    expect(result!.high).toBeGreaterThanOrEqual(4.3);
    expect(result!.low).toBeGreaterThan(2);
    expect(result!.n).toBe(10);
    expect(pairedBootstrap([], 100, rng(1))).toBeNull();
  });

  it("gives a zero width interval for identical differences", () => {
    expect(pairedBootstrap([2, 2, 2], 500, rng(3))).toEqual({ n: 3, mean: 2, low: 2, high: 2 });
  });
});
