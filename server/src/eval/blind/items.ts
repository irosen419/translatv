// The blind test's input: eval/blind/sentences.jsonl, a synthetic set written for this test (see
// eval/blind/README.md). One item is one line to translate.

import type { ContextTurn } from "../../translate/prompt.js";
import { CONTEXT_TURNS } from "../../translate/prompt.js";

export interface BlindItem {
  id: string;
  conv: string;
  seq: number;
  src: string;
  tgt: string;
  text: string;
  address: "singular" | "plural" | "none";
  tags: string[];
}

/** The five targets, in the order every per target table and every interleave uses. */
export const TARGETS = ["es-AR", "es-CO", "es-MX", "es-ES", "en-US"] as const;

/**
 * The display name every context line carries. Production sends the speaker's username; the set
 * has no speakers, and each conversation is one person talking, so one fixed name stands in.
 */
export const SPEAKER = "Speaker";

const ADDRESSES = new Set(["singular", "plural", "none"]);

/** Every line, in file order. A line that is not an item throws, naming it: nothing is skipped. */
export function parseItems(text: string): BlindItem[] {
  const out: BlindItem[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) return;
    const value = JSON.parse(line) as Partial<BlindItem>;
    const ok =
      typeof value.id === "string" &&
      typeof value.conv === "string" &&
      typeof value.seq === "number" &&
      typeof value.src === "string" &&
      typeof value.tgt === "string" &&
      typeof value.text === "string" &&
      typeof value.address === "string" &&
      ADDRESSES.has(value.address) &&
      Array.isArray(value.tags);
    if (!ok) throw new Error(`sentences line ${index + 1} is not a blind test item`);
    out.push(value as BlindItem);
  });
  return out;
}

/**
 * A subset of `limit` items, as even across the five targets as the number allows (the first
 * targets take any remainder), each target's share spread evenly through its lines rather than
 * taken from the top, so a 10 item smoke run still sees lines with context. Null, or a limit at
 * or past the set, is the whole set. Returned in file order.
 */
export function selectBalanced(items: readonly BlindItem[], limit: number | null): BlindItem[] {
  if (limit === null || limit >= items.length) return [...items];
  const chosen = new Set<string>();
  TARGETS.forEach((target, t) => {
    const pool = items.filter((i) => i.tgt === target);
    const share = Math.floor(limit / TARGETS.length) + (t < limit % TARGETS.length ? 1 : 0);
    for (let k = 0; k < Math.min(share, pool.length); k += 1) {
      chosen.add(pool[Math.floor((k * pool.length) / share)]!.id);
    }
  });
  return items.filter((i) => chosen.has(i.id));
}

/**
 * The items, taking one from each target in turn, so a run cut short by its budget at any point
 * has judged (or translated) about as many of each target.
 */
export function interleaveByTarget(items: readonly BlindItem[]): BlindItem[] {
  const queues = TARGETS.map((target) => items.filter((i) => i.tgt === target));
  const others = items.filter((i) => !(TARGETS as readonly string[]).includes(i.tgt));
  const out: BlindItem[] = [];
  for (let round = 0; queues.some((q) => round < q.length); round += 1) {
    for (const queue of queues) if (round < queue.length) out.push(queue[round]!);
  }
  return [...out, ...others];
}

/**
 * The context production would pass for this line: RoomSession keeps the last CONTEXT_TURNS lines
 * of the room including the one being translated, and contextFor drops that one. So: up to
 * CONTEXT_TURNS less one earlier lines of the same conversation, oldest first, as spoken.
 */
export function contextFor(all: readonly BlindItem[], item: BlindItem): ContextTurn[] {
  return all
    .filter((other) => other.conv === item.conv && other.seq < item.seq)
    .sort((a, b) => a.seq - b.seq)
    .slice(-(CONTEXT_TURNS - 1))
    .map((other) => ({ username: SPEAKER, dialect: other.src, text: other.text }));
}
