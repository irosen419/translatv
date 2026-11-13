// The two public pages, /privacy and /support: which path is which, and what each one says, as
// an outline of copy keys. The words live in the locale files like every other word on screen,
// so the pages read in the reader's language; this file only decides the order and the shape.
//
// Both pages render before the session is looked at (App.tsx), so they work signed out, and both
// are ordinary paths the server's SPA fallback already serves index.html for.

import { LIMITS, REPORT_DETAILS_MAX, TERM_MAX_WORDS } from "@translatv/shared";

import type { CopyKey, CopyParams } from "../i18n/copy.js";

export type InfoPageName = "privacy" | "support";

/**
 * The privacy policy is a draft until the owner has reviewed it, and says so on the page.
 * The ONE switch: set it to false when the owner signs it off (and fill every [OWNER: ...]).
 */
export const PRIVACY_IS_DRAFT = true;

/** Which public page a path names, if any. Exact paths only, so nothing else lands here. */
export function pageFromPath(pathname: string): InfoPageName | null {
  const match = pathname.match(/^\/(privacy|support)\/?$/);
  return match ? (match[1] as InfoPageName) : null;
}

export type Block =
  | { kind: "paragraph"; key: CopyKey }
  | { kind: "list"; items: CopyKey[] }
  /** One line, and the support address after it when the server has one, else the other line. */
  | { kind: "contact"; withEmail: CopyKey; withoutEmail: CopyKey };

export interface Section {
  heading: CopyKey;
  /** 2 for a section, 3 for a part of the section before it. */
  level: 2 | 3;
  blocks: Block[];
}

export interface InfoPageOutline {
  title: CopyKey;
  /** Values for the {placeholders} in its lines: the limits the code enforces, never retyped. */
  params: CopyParams;
  sections: Section[];
}

const p = (key: CopyKey): Block => ({ kind: "paragraph", key });

export const INFO_PAGES: Readonly<Record<InfoPageName, InfoPageOutline>> = {
  privacy: {
    title: "privacy.title",
    params: { words: TERM_MAX_WORDS, max: LIMITS.glossaryEntries, detailsMax: REPORT_DETAILS_MAX },
    sections: [
      { heading: "privacy.age.h", level: 2, blocks: [p("privacy.age.p")] },
      {
        heading: "privacy.stores.h",
        level: 2,
        blocks: [
          {
            kind: "list",
            items: [
              "privacy.stores.email",
              "privacy.stores.password",
              "privacy.stores.name",
              "privacy.stores.sessions",
              "privacy.stores.dialect",
              "privacy.stores.glossary",
              "privacy.stores.calls",
              "privacy.stores.blocks",
              "privacy.stores.reports",
            ],
          },
        ],
      },
      { heading: "privacy.never.h", level: 2, blocks: [p("privacy.never.p1"), p("privacy.never.p2")] },
      {
        heading: "privacy.call.h",
        level: 2,
        blocks: [p("privacy.call.media"), p("privacy.call.stun"), p("privacy.call.relay"), p("privacy.call.speech")],
      },
      { heading: "privacy.translate.h", level: 2, blocks: [p("privacy.translate.p")] },
      { heading: "privacy.logs.h", level: 2, blocks: [p("privacy.logs.p1"), p("privacy.logs.p2"), p("privacy.logs.p3")] },
      { heading: "privacy.browser.h", level: 2, blocks: [p("privacy.browser.p")] },
      { heading: "privacy.delete.h", level: 2, blocks: [p("privacy.delete.p1"), p("privacy.delete.p2")] },
      { heading: "privacy.share.h", level: 2, blocks: [p("privacy.share.p")] },
      { heading: "privacy.rights.h", level: 2, blocks: [p("privacy.rights.p")] },
      {
        heading: "privacy.contact.h",
        level: 2,
        blocks: [{ kind: "contact", withEmail: "privacy.contact.with", withoutEmail: "privacy.contact.without" }],
      },
    ],
  },
  support: {
    title: "support.title",
    params: {},
    sections: [
      {
        heading: "support.help.h",
        level: 2,
        blocks: [{ kind: "contact", withEmail: "support.help.with", withoutEmail: "support.help.without" }],
      },
      {
        heading: "support.safety.h",
        level: 2,
        blocks: [
          { kind: "list", items: ["support.safety.call", "support.safety.history"] },
          p("support.safety.block"),
          p("support.safety.report"),
          p("support.safety.danger"),
        ],
      },
      { heading: "support.delete.h", level: 2, blocks: [p("support.delete.p")] },
      { heading: "support.fixes.h", level: 2, blocks: [] },
      {
        heading: "support.media.h",
        level: 3,
        blocks: [{ kind: "list", items: ["support.media.allow", "support.media.busy", "support.media.secure"] }],
      },
      {
        heading: "support.stt.h",
        level: 3,
        blocks: [{ kind: "list", items: ["support.stt.browser", "support.stt.ios", "support.stt.drops"] }],
      },
      {
        heading: "support.net.h",
        level: 3,
        blocks: [{ kind: "list", items: ["support.net.firewall", "support.net.grace", "support.net.restart"] }],
      },
    ],
  },
};

export interface Piece {
  text: string;
  placeholder: boolean;
}

/** Split a line around its [OWNER: ...] blanks, so the page can mark each one. */
export function splitPlaceholders(line: string): Piece[] {
  const pieces: Piece[] = [];
  for (const part of line.split(/(\[OWNER:[^\]]*\])/)) {
    if (part === "") continue;
    pieces.push({ text: part, placeholder: part.startsWith("[OWNER:") });
  }
  return pieces;
}
