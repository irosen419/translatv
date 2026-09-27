// Structured logging that REFUSES to carry conversation content.
//
// The privacy promise of this app is that nothing is stored. A log line containing a transcript
// would break that promise quietly, in a file nobody looks at until they do. So rather than
// relying on every call site to remember, the serializer drops the dangerous keys itself, and a
// unit test asserts it.
//
// What is safe to log: identifiers, counts, durations, outcomes. What is not: anything a human
// said or typed.

/** Keys that carry conversation content and are dropped, at any depth. */
const FORBIDDEN_KEYS = new Set([
  "text",
  "original",
  "translated",
  "transcript",
  "username",
  "correctedTranslation",
  "glossary",
  "entries",
  "sdp",
  "candidate",
  "note",
  "resumeToken",
]);

export type LogFields = Record<string, unknown>;

/**
 * Strip forbidden keys, recursively.
 *
 * Replaces rather than deletes, so a reader can tell the difference between "this event had no
 * text" and "this event's text was withheld". A silent deletion would make a log look like the
 * field never existed.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      out[key] = typeof inner === "string" ? `[withheld ${inner.length} chars]` : "[withheld]";
      continue;
    }
    out[key] = scrub(inner, depth + 1);
  }
  return out;
}

type Level = "info" | "warn" | "error";

function emit(level: Level, event: string, fields: LogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(scrub(fields) as LogFields),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};
