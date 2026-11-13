// A deterministic stand in for the API, for `npm run blind -- --dry-run` and the tests: the whole
// pipeline runs, ledger rows and all, with no key, no network and no money.
//
// What it returns is shaped to exercise every path the real run can take, not to look like good
// translation: arms that differ, arms B and C answering identically on some items (so the judge
// sees one candidate where two arms agree), an occasional refusal from arm C, thinking tokens on
// arm C, and a judge that answers with valid structured output. Token counts are a quarter of the
// prompt's bytes, which is about right for English and is only ever written to a temporary ledger.

import type { RequestProfile } from "../../translate/anthropic.js";
import type { LlmClient } from "../../translate/TranslationService.js";
import { ERROR_TAGS } from "./arms.js";
import { seedFrom } from "./stats.js";

const tokens = (text: string): number => Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));

function utterance(user: string): string {
  return /<utterance>([\s\S]*)<\/utterance>/.exec(user)?.[1] ?? "";
}

function translation(model: string, profile: RequestProfile, line: string): { text: string; stopReason: string } {
  const hash = seedFrom(line);
  if (profile.thinking === "adaptive" && hash % 40 === 0) return { text: "", stopReason: "refusal" };
  if (model === "claude-haiku-4-5") return { text: `[A] ${line}`, stopReason: "end_turn" };
  // B and C agree on two lines in three.
  if (profile.thinking === "adaptive" && hash % 3 === 0) return { text: `[C] ${line}`, stopReason: "end_turn" };
  return { text: `[B/C] ${line}`, stopReason: "end_turn" };
}

function judgement(user: string): string {
  const data = /<data>\n([\s\S]*)\n<\/data>/.exec(user)?.[1] ?? "{}";
  const candidates = (JSON.parse(data) as { candidates?: Record<string, string> }).candidates ?? {};
  const ratings = Object.entries(candidates).map(([label, text]) => {
    const hash = seedFrom(text);
    return {
      candidate: Number(label),
      score: 40 + (hash % 61),
      right_dialect: hash % 5 !== 0,
      errors: hash % 4 === 0 ? [ERROR_TAGS[hash % ERROR_TAGS.length]] : [],
    };
  });
  return JSON.stringify({ ratings });
}

export function fakeClient(model: string, profile: RequestProfile): LlmClient {
  return {
    async complete({ system, user, signal }) {
      await new Promise((resolve) => setImmediate(resolve));
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const inputTokens = tokens(system) + tokens(user);
      if (profile.jsonSchema !== null) {
        const text = judgement(user);
        return { text, inputTokens, outputTokens: tokens(text) + 120, stopReason: "end_turn" };
      }
      const { text, stopReason } = translation(model, profile, utterance(user));
      const thinking = profile.thinking === "adaptive" ? 60 : 0;
      return { text, inputTokens, outputTokens: tokens(text || "x") + thinking, stopReason };
    },
  };
}
