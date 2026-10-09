// The one place node:sqlite is loaded.
//
// node:sqlite prints "ExperimentalWarning: SQLite is an experimental feature" when it is first
// loaded, on every boot and in every test worker. Three ways to quiet it were weighed:
//
//   --disable-warning=ExperimentalWarning on the command line. It has to be repeated in the
//     server start script, the Dockerfile CMD, the dev watcher and the vitest execArgv, and a
//     place that forgets it prints the warning again. It also silences EVERY experimental
//     feature, so a future one would arrive without the notice it deserves.
//   A process.on("warning") listener. Adding one does not stop Node's default printer, so it
//     suppresses nothing.
//   Dropping exactly this one warning, here, for the duration of the load. That is what this
//     does: process.emitWarning is wrapped only while the module is required, the wrapper
//     swallows a warning only when it is an ExperimentalWarning whose message starts with
//     "SQLite", and the original is restored in a finally before anything else can run.
//
// The last one is the least invasive: no flag in four places, no global change that outlives the
// load, and every other warning still prints. createRequire rather than a static import because a
// static import is hoisted above any code in this module, so the wrapper could not be in place
// before the warning fires.

import { createRequire } from "node:module";
import type * as Sqlite from "node:sqlite";

type EmitWarning = typeof process.emitWarning;

/** Is this the SQLite experimental warning, and nothing else? Arguments as emitWarning takes them. */
export function isSqliteExperimentalWarning(warning: unknown, typeOrOptions: unknown): boolean {
  const type =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : typeof typeOrOptions === "object" && typeOrOptions !== null
        ? (typeOrOptions as { type?: unknown }).type
        : undefined;
  if (type !== "ExperimentalWarning") return false;
  const message = warning instanceof Error ? warning.message : String(warning);
  return message.startsWith("SQLite ");
}

function load(): typeof Sqlite {
  const original: EmitWarning = process.emitWarning;
  const filtered = function (this: unknown, warning: unknown, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as EmitWarning;
  process.emitWarning = filtered;
  try {
    return createRequire(import.meta.url)("node:sqlite") as typeof Sqlite;
  } finally {
    process.emitWarning = original;
  }
}

export const { DatabaseSync } = load();
export type DatabaseSync = Sqlite.DatabaseSync;
