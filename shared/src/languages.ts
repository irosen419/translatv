// The language and dialect catalog. Shared so the client's picker and the server's translation
// prompts cannot disagree about what a locale means.
//
// The dialect fragments are the feature. DeepL and Google Translate essentially cannot be told
// to produce voseo; an LLM can, because it is a prompt parameter. Each fragment carries two
// short exemplar pairs, and the exemplars are what actually pin the register: the instruction
// alone drifts back toward textbook Spanish after a few turns.

export type LanguageCode = "en" | "es";

export interface Dialect {
  /** BCP 47 tag. Also handed to SpeechRecognition as its lang, which improves accuracy. */
  readonly code: string;
  readonly language: LanguageCode;
  /** Shown in the picker. */
  readonly label: string;
  /** Human readable name used inside the translation prompt. */
  readonly promptName: string;
  /** The instruction that produces this dialect's register. */
  readonly instruction: string;
  /** Few shot pairs. These pin the register harder than the instruction does. */
  readonly exemplars: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

export const DIALECTS: readonly Dialect[] = Object.freeze([
  Object.freeze({
    code: "en-US",
    language: "en",
    label: "English (United States)",
    promptName: "American English",
    instruction:
      "American English. Use American spelling and idiom. Keep the register conversational.",
    exemplars: Object.freeze([
      { from: "Que tengas un buen finde.", to: "Have a good weekend." },
      { from: "Se me hizo tarde, disculpa.", to: "I'm running late, sorry." },
    ]),
  }),
  Object.freeze({
    code: "en-GB",
    language: "en",
    label: "English (United Kingdom)",
    promptName: "British English",
    instruction:
      "British English. Use British spelling (colour, realise, favourite) and British idiom " +
      "(brilliant, cheers, reckon). Keep the register conversational.",
    exemplars: Object.freeze([
      { from: "Que tengas un buen finde.", to: "Have a good weekend." },
      { from: "Buenisimo, gracias.", to: "Brilliant, cheers." },
    ]),
  }),
  Object.freeze({
    code: "es-AR",
    language: "es",
    label: "Espanol (Argentina)",
    promptName: "Rioplatense Spanish as spoken in Buenos Aires",
    instruction:
      "Rioplatense Spanish as spoken in Buenos Aires. Use VOSEO throughout: vos tenes, vos sos, " +
      "vos podes, veni, mira, deci. NEVER use tu or tienes or puedes. Use ustedes for plural you, " +
      "never vosotros. Argentine colloquial vocabulary where it is natural: che, barbaro, laburo, " +
      "quilombo, dale.",
    exemplars: Object.freeze([
      { from: "Do you have time tomorrow?", to: "Tenes tiempo manana?" },
      { from: "You are right, come whenever you want.", to: "Tenes razon, veni cuando quieras." },
    ]),
  }),
  Object.freeze({
    code: "es-MX",
    language: "es",
    label: "Espanol (Mexico)",
    promptName: "Mexican Spanish",
    instruction:
      "Mexican Spanish. Use tu for singular you and ustedes for plural you, NEVER vosotros. " +
      "Mexican colloquial vocabulary where it is natural: orale, ahorita, chido, que onda.",
    exemplars: Object.freeze([
      { from: "Do you have time tomorrow?", to: "Tienes tiempo manana?" },
      { from: "You are right, come whenever you want.", to: "Tienes razon, ven cuando quieras." },
    ]),
  }),
  Object.freeze({
    code: "es-ES",
    language: "es",
    label: "Espanol (Espana)",
    promptName: "Peninsular Spanish",
    instruction:
      "Peninsular Spanish as spoken in Spain. Use tu for singular you and VOSOTROS for plural " +
      "you: vosotros teneis, venid, sabeis. Peninsular vocabulary where it is natural: vale, " +
      "tio, guay, molar.",
    exemplars: Object.freeze([
      { from: "Do you have time tomorrow?", to: "Tienes tiempo manana?" },
      { from: "Do you all want to come?", to: "Quereis venir vosotros?" },
    ]),
  }),
  Object.freeze({
    code: "es-CO",
    language: "es",
    label: "Espanol (Colombia)",
    promptName: "Colombian Spanish as spoken in Bogota",
    instruction:
      "Colombian Spanish as spoken in Bogota. Use USTED even in familiar register, which is the " +
      "Bogotano norm. Colombian colloquial vocabulary where it is natural: bacano, parcero, " +
      "chevere, si o que. Avoid Mexican and Argentine slang.",
    exemplars: Object.freeze([
      { from: "Do you have time tomorrow?", to: "Tiene tiempo manana?" },
      { from: "You are right, come whenever you want.", to: "Tiene razon, venga cuando quiera." },
    ]),
  }),
]);

export const DIALECT_CODES = DIALECTS.map((d) => d.code);

export function dialectByCode(code: string): Dialect | null {
  return DIALECTS.find((d) => d.code === code) ?? null;
}

export function languageOf(dialectCode: string): LanguageCode | null {
  return dialectByCode(dialectCode)?.language ?? null;
}

/** Every dialect for a language, for the picker's grouping. */
export function dialectsFor(language: LanguageCode): readonly Dialect[] {
  return DIALECTS.filter((d) => d.language === language);
}

/**
 * Whether turning `source` into `target` needs an actual translation.
 *
 * THREE answers, not two, and the third one is the point.
 *
 *   "no"       both sides are the same BASE language. Compared by language and not by dialect
 *              code, so en-US to en-GB and es-AR to es-MX are both "no": two people who picked
 *              different regions of one language do not need a model, and charging them for one
 *              would be waste they never asked for.
 *   "yes"      two different languages, both resolved.
 *   "unknown"  at least one code is not in the catalog, so there is no honest answer.
 *
 * "unknown" exists because this used to return a bare boolean and resolve an unrecognized code to
 * FALLBACK_DIALECT first. That made an unresolvable dialect facing any English speaker come back
 * "no translation needed", so every line passed through untranslated, unmarked, and unexplained.
 * The same failure the spend ledger's honesty rules already forbid: an unrecoverable value is
 * reported as unknown, never as a convenient default that happens to be wrong.
 *
 * The caller decides what "unknown" means, and this repo's answer is to REFUSE and say so on
 * screen. What a caller may not do is treat it as either of the other two by accident, which is
 * why this is a union and not a boolean with a comment.
 *
 * Both halves of the server derive their verdict from this one function, so the early skip in the
 * WS handler and TranslationService's own backstop cannot drift apart. When they did drift, the
 * handler took a rate limit token and announced a pending translation while the service quietly
 * echoed the text, and the result was labelled as coming from a model that never saw it.
 */
export type TranslationNeed = "yes" | "no" | "unknown";

export function translationNeed(sourceDialect: string, targetDialect: string): TranslationNeed {
  const source = languageOf(sourceDialect);
  const target = languageOf(targetDialect);
  if (source === null || target === null) return "unknown";
  return source === target ? "no" : "yes";
}

/**
 * Best dialect for a browser language tag, with a fallback chain.
 *
 * Tries the exact tag ("es-AR"), then any dialect of the same base language ("es" picks the
 * first Spanish entry), then null. The caller decides what null means: the UI offers a picker
 * rather than guessing, because guessing a Spanish speaker's region wrong is more annoying than
 * asking.
 */
export function detectDialect(navigatorLanguage: string | undefined): Dialect | null {
  if (!navigatorLanguage) return null;

  const tag = navigatorLanguage.trim();
  const exact = DIALECTS.find((d) => d.code.toLowerCase() === tag.toLowerCase());
  if (exact) return exact;

  const base = tag.split("-")[0]?.toLowerCase();
  if (!base) return null;
  return DIALECTS.find((d) => d.language === base) ?? null;
}

/**
 * The default the PICKER starts on when detection fails entirely.
 *
 * A starting value for a control the user can see and change, which is the only place a default
 * dialect is honest. It is deliberately NOT used to resolve an unrecognized code anywhere: that
 * is the silent wrong answer translationNeed exists to refuse.
 */
export const FALLBACK_DIALECT = "en-US";
