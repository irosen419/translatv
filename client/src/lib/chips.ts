// The status chips, and the one distinction that decides where each is allowed to live.
//
// Extracted from Room.tsx when the mobile layout moved the room header into a drawer. A chip that
// reports a PROBLEM has to stay on screen: hiding "subtitles reconnecting" behind a gear means the
// first you learn of it is when you wonder why nobody is replying. A chip that reports a state
// nobody needs to act on can go in the drawer with everything else.
//
// The tone field already carried that distinction, so this reads it rather than inventing a
// second, parallel classification that could disagree with the colours on screen.

import type { TranslationFailureCode } from "@translatv/shared";

import { failureCopyKey } from "../i18n/codes.js";
import type { CopyKey, CopyRef } from "../i18n/copy.js";
import type { SttStatus } from "../stt/types.js";

/**
 * A chip, as a decision rather than as words.
 *
 * `text` and `title` are copy keys, not sentences. This module decides WHICH chips exist, which
 * is a question about the state of the call and has nothing to do with the language the person
 * watching it reads, and keeping it that way is what lets the whole strip change language the
 * moment somebody moves the dialect picker.
 */
export interface Chip {
  text: CopyKey;
  tone: string;
  title?: CopyRef | readonly CopyRef[];
  onClick?: () => void;
}

export interface ChipState {
  peerPresent: boolean;
  peerConnection: "connected" | "reconnecting" | null;
  peerState: string;
  socketState: string;
  sttStatus: SttStatus;
  peerName: string | null;
  peerMicEnabled: boolean;
  peerWantsTranslation: boolean;
  /**
   * Why translation is not going to work for this call, as a wire code, or null.
   *
   * A CODE, not the server's sentence. This used to be English prose straight off the wire, and
   * it went onto the screen of whoever was in the call whatever language they had picked.
   */
  translationUnavailable: TranslationFailureCode | null;
  onToggleSttEngine(): void;
}

/** Is this chip telling the user something is wrong right now? */
export function isProblem(chip: Chip): boolean {
  return chip.tone === "warn" || chip.tone === "bad";
}

export function buildChips(state: ChipState): Chip[] {
  const {
    peerPresent,
    peerConnection,
    peerState,
    socketState,
    sttStatus,
    peerName,
    peerMicEnabled,
    peerWantsTranslation,
    translationUnavailable,
    onToggleSttEngine,
  } = state;
  const chips: Chip[] = [];

  // First in the list, and tone "bad" so it counts as a problem and floats over the video on a
  // phone rather than hiding in the drawer. Translation IS the product: a call where it has
  // stopped for good is the single most important thing on this screen, and until this chip
  // existed the state was recorded in the store and rendered nowhere.
  //
  // The title says WHICH failure this is. It separates "no key configured" from "the key was
  // rejected" from "a language in this call could not be resolved", and only one of those is
  // something the user can do anything about. Two whole sentences, joined: the reason, then the
  // reassurance that the rest of the call is fine.
  if (translationUnavailable) {
    chips.push({
      text: "chips.translationUnavailable",
      tone: "bad",
      title: [
        { key: failureCopyKey(translationUnavailable) },
        { key: "chips.translationUnavailable.stillWorks" },
      ],
    });
  }

  if (peerPresent && !peerMicEnabled) {
    chips.push({
      text: "chips.muted",
      tone: "warn",
      // Two keys rather than one with a fallback name spliced in. A default like "They" is a
      // WORD, and splicing an English word into an otherwise Spanish tooltip is the exact seam
      // this change exists to close. A whole sentence per case translates; a half one does not.
      title: peerName
        ? { key: "chips.muted.title", params: { name: peerName } }
        : { key: "chips.muted.titleNoName" },
    });
  }

  // Not decoration. Translation results are broadcast to BOTH people, so you normally watch your
  // own words appear translated into their language. The moment they turn translation off, that
  // stops, and without this chip the only visible evidence is your own subtitles going quiet,
  // which reads as the app breaking rather than as a choice somebody made.
  if (peerPresent && !peerWantsTranslation) {
    chips.push({
      text: "chips.translationOff",
      tone: "warn",
      title: { key: "chips.translationOff.title" },
    });
  }

  if (socketState === "reconnecting") {
    chips.push({
      text: "chips.reconnecting",
      tone: "warn",
      title: { key: "chips.reconnecting.title" },
    });
  }

  if (peerPresent && peerConnection === "reconnecting") {
    chips.push({
      text: "chips.peerDropped",
      tone: "warn",
      title: { key: "chips.peerDropped.title" },
    });
  }

  if (peerPresent && peerState === "failed") {
    chips.push({
      text: "chips.noMedia",
      tone: "bad",
      title: { key: "chips.noMedia.title" },
    });
  } else if (peerPresent && (peerState === "interrupted" || peerState === "recovering")) {
    chips.push({ text: "chips.mediaUnstable", tone: "warn" });
  }

  // Speech status. The engine is shown in BOTH states, unlike the purely diagnostic chips above,
  // because it is a control: which engine is running is the single biggest lever on how good the
  // subtitles are, and a control you cannot see is one nobody uses.
  switch (sttStatus.kind) {
    case "listening":
      chips.push(
        sttStatus.onDevice
          ? {
              text: "chips.onDevice",
              tone: "good",
              title: { key: "chips.onDevice.title" },
              onClick: onToggleSttEngine,
            }
          : {
              text: "chips.cloud",
              // Same tone as the on device state, deliberately. This is ONE control with two
              // settings, and neither is a fault. The cloud state used to be toneless, which
              // next to a toned on device chip read as "something is missing here" rather than
              // as the other half of a toggle. Whether the audio leaves the machine is said by
              // the word, which is the thing that has to carry it anyway: colour cannot express
              // "on device" versus "cloud" to someone who has not already been told what the
              // two colours mean.
              tone: "good",
              title: { key: "chips.cloud.title" },
              onClick: onToggleSttEngine,
            },
      );
      break;
    case "downloading":
      chips.push({ text: "chips.preparing", tone: "warn" });
      break;
    case "reconnecting":
      chips.push({ text: "chips.sttReconnecting", tone: "warn" });
      break;
    case "blocked":
    case "failed":
      // The adapter already decided WHAT went wrong and handed back a ref, so the instructions
      // in this tooltip are in the reader's language without this module knowing one word of it.
      chips.push({ text: "chips.noSubtitles", tone: "bad", title: sttStatus.notice });
      break;
    default:
      break;
  }

  return chips;
}
