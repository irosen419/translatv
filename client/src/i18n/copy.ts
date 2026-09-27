// Every word the app puts on screen, and the lookup that picks the right one.
//
// The server sends CODES. This is where they become sentences, in the language the reader chose
// to speak, because only the client knows who is reading. Two people in the same room read the
// same room in two different languages, and that is only possible if no user facing sentence is
// ever decided anywhere else.
//
// The shape is base language files plus THIN per dialect overrides. en.json and es.json carry
// all of the copy; es-AR.json and friends carry only the keys that genuinely differ, which in
// practice means second person: "Type a message" is Escribe, Escribí or Escriba depending on who
// is reading, and nothing else about the sentence changes. Resolution goes exact dialect, then
// base language, then English, which is the same chain detectDialect already walks in
// shared/src/languages.ts.
//
// There is deliberately NO es-MX.json. Base Spanish here is tu plus ustedes, which IS the
// Mexican register, so the file would be a copy of es.json with nothing in it that differed. An
// override file that only restates its base is worse than no file: it has to be kept in step by
// hand forever, and the day it falls behind it silently wins over the base it was copied from.

import { languageOf } from "@translatv/shared";

import en from "./en.json";
import es from "./es.json";
import esAR from "./es-AR.json";
import esCO from "./es-CO.json";
import esES from "./es-ES.json";

/**
 * Every key the app can ask for, taken from the English file.
 *
 * English is the type because it is the end of the fallback chain: a key that exists there is a
 * key that always resolves to real prose. Deriving the type this way is what makes a typo a
 * compile error rather than a blank space someone notices mid call.
 */
export type CopyKey = keyof typeof en;

export type CopyParams = Readonly<Record<string, string | number>>;

/**
 * A key and its values, chosen somewhere that cannot render.
 *
 * Media acquisition, the speech adapter and the transcript importer all decide WHAT went wrong
 * long before anything knows who will read it. They hand back one of these and the component
 * renders it in the reader's own dialect, which is why a failure raised before anyone picked a
 * language still comes out in the right one once they have.
 */
export interface CopyRef {
  key: CopyKey;
  params?: CopyParams;
}

/** The copy resolved for one dialect. */
export interface Copy {
  /** The dialect this was resolved for, so a caller can key a memo on it. */
  readonly dialect: string;
  t(key: CopyKey, params?: CopyParams): string;
  /** Render a ref made away from the screen. Nothing to say renders as nothing. */
  ref(ref: CopyRef | readonly CopyRef[] | null | undefined): string;
  /**
   * Every key with the string this dialect resolves it to.
   *
   * Exists for the register tests, which have to sweep a whole dialect rather than spot check
   * it: one stray "tu tienes" in a tooltip is exactly the kind of thing a per key test never
   * looks at. Entries rather than bare strings so a sweep can exclude the handful of keys that
   * QUOTE another dialect on purpose.
   */
  all(): ReadonlyArray<readonly [CopyKey, string]>;
}

type Table = Readonly<Partial<Record<CopyKey, string>>>;

/**
 * The base language files, complete by construction.
 *
 * Typed as a full Record rather than a Partial, so a key added to English and forgotten in
 * Spanish will not compile. script/check_copy.mjs reports the same thing in a sentence a person
 * can act on, and runs first; this is the backstop that makes the hole impossible rather than
 * merely reported.
 */
const BASE: Readonly<Record<string, Record<CopyKey, string>>> = {
  en,
  es,
};

/**
 * The per dialect overrides, typed as partial and keyed by CopyKey.
 *
 * An override naming a key the base file does not have is a compile error here, which is the
 * other half of what check_copy.mjs reports: a dialect file is a set of DIFFERENCES, and a key
 * that exists nowhere else is a key nothing will ever ask for.
 */
const OVERRIDES: Readonly<Record<string, Table>> = {
  "es-AR": esAR,
  "es-CO": esCO,
  "es-ES": esES,
};

/** The end of every chain. */
const FALLBACK_LANGUAGE = "en";

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Substitute {name} style placeholders.
 *
 * Exported because it is the primitive rather than a detail: it is pure, it is the one piece of
 * this file with edge cases worth testing directly, and the format is deliberately the smallest
 * thing that serves the strings the app actually has. There is no pluralization engine here. One
 * string needs a plural (the count of imported corrections) and it is handled by two keys and a
 * ternary at its single call site, which is a tenth of the machinery and reads at a glance.
 *
 * A placeholder with no value becomes `missing` rather than disappearing. Dropping it would
 * render "turned their camera off" with nobody's name in front of it, which is not a smaller
 * version of the truth, it is a different sentence. Same rule as an unrecoverable cost in the
 * spend ledger: unknown is reported as unknown, never as a convenient default.
 */
export function interpolate(template: string, params: CopyParams, missing: string): string {
  if (!template.includes("{")) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      console.error(`copy: no value for ${whole}`);
      return missing;
    }
    return String(value);
  });
}

/**
 * The files to consult, in order, for one dialect.
 *
 * English last, always, including for Spanish: a Spanish reader shown an English sentence has at
 * least been told something true, where a blank or a raw key tells them the app is broken.
 */
function chainFor(dialect: string): Table[] {
  // languageOf only knows full dialect codes from the catalog. A bare language tag ("es") is a
  // legitimate thing to ask for, and splitting on the hyphen is the same widening detectDialect
  // already does, so "fr-FR" lands on "fr", finds no file, and falls through to English.
  const language = languageOf(dialect) ?? dialect.split("-")[0];
  const chain: Table[] = [];

  const override = OVERRIDES[dialect];
  if (override) chain.push(override);

  // A language with no file of its own is not an error, it is a language nobody has translated
  // yet. It falls through to English rather than failing to resolve.
  if (language && BASE[language]) chain.push(BASE[language]);
  chain.push(BASE[FALLBACK_LANGUAGE]!);

  return chain;
}

/**
 * Resolved copy, memoized per dialect.
 *
 * The memo matters because this is read during render, several times per component, and the
 * dialect changes only when somebody picks a new one. It is keyed on the dialect string, so
 * switching mid call gets a different object and every component that reads it repaints.
 */
const cache = new Map<string, Copy>();

export function copyFor(dialect: string): Copy {
  const cached = cache.get(dialect);
  if (cached) return cached;

  const chain = chainFor(dialect);

  function lookup(key: CopyKey): string | undefined {
    for (const table of chain) {
      const value = table[key];
      if (value !== undefined) return value;
    }
    return undefined;
  }

  const copy: Copy = {
    dialect,
    t(key, params) {
      const template = lookup(key);
      if (template === undefined) {
        // Unreachable through CopyKey, which is derived from the English file. Reachable through
        // a cast, and what matters then is that the screen says something honest: never the key
        // itself, which is jargon aimed at the wrong person, and never an empty string, which
        // reads as a rendering bug rather than as missing words. The key goes to the console,
        // where the person who can fix it is looking.
        console.error(`copy: no such key ${String(key)}`);
        // In the READER's language. Being told something is missing is only useful if you can
        // read the telling.
        return lookup("copy.missing") ?? en["copy.missing"];
      }
      return interpolate(template, params ?? {}, lookup("copy.unknown") ?? en["copy.unknown"]);
    },
    ref(value) {
      if (!value) return "";
      // An ARRAY is several whole sentences, each looked up on its own and then joined. Not a
      // sentence assembled from fragments: a tooltip built by splicing translated pieces reads
      // as machine output in any language whose word order is not English's. Composing at the
      // sentence boundary is the one join that survives translation.
      if (Array.isArray(value)) return value.map((one) => copy.t(one.key, one.params)).join(" ");
      const single = value as CopyRef;
      return copy.t(single.key, single.params);
    },
    all() {
      const keys = Object.keys(en) as CopyKey[];
      return keys.map((key) => [key, lookup(key) ?? ""] as const);
    },
  };

  cache.set(dialect, copy);
  return copy;
}
