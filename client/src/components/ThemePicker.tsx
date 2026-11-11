import type { ReactElement, ReactNode } from "react";

import type { Copy, CopyKey } from "../i18n/copy.js";
import { THEMES } from "../theme/palettes.js";
import {
  isPaletteId,
  isThemeMode,
  THEME_MODES,
  type ThemeChoice,
  type ThemeMode,
} from "../theme/theme.js";
import { SelectShell } from "./SelectShell.jsx";

/** The palette control, and the stem of its label's id. */
const PALETTE_ID = "theme-palette";

/** The appearance control, and the stem of its label's id. */
const MODE_ID = "theme-mode";

function modeKey(mode: ThemeMode): CopyKey {
  return `room.theme.mode.${mode}`;
}

/** The id of the label that names a control, for anything else that has to point at it. */
function labelIdFor(controlId: string): string {
  return `${controlId}-label`;
}

/**
 * One of the two glyphs that introduce these controls.
 *
 * Same house style as the gear in ControlDrawer and the self view icons in Room: a 24 unit
 * viewBox, currentColor strokes, drawn here so the app still takes no icon dependency. As with
 * the chevron in SelectShell, the SIZE is left to the stylesheet, which pads the option text
 * clear of the glyph and so has to be the one place that number lives.
 *
 * `data-icon` is not decoration. It is the stable name the node suite asserts on, the same hook
 * the microphone and camera icons carry, so a test can say WHICH icon was drawn without reading
 * path geometry that moves whenever somebody nudges a curve.
 */
function SelectIcon({ name, children }: { name: string; children: ReactNode }): ReactElement {
  return (
    <svg
      className="select-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {children}
    </svg>
  );
}

/** A painter's palette: the one shape that reads as "colours" rather than as "settings". */
function PaletteIcon(): ReactElement {
  return (
    <SelectIcon name="palette">
      <path d="M12 3a9 9 0 0 0 0 18 1.8 1.8 0 0 0 1.8-1.8c0-.5-.2-.9-.5-1.2a1.8 1.8 0 0 1 1.3-3H16a5 5 0 0 0 5-5c0-3.9-4-7-9-7z" />
      <circle cx="7.5" cy="11.5" r="1.1" />
      <circle cx="11" cy="7.5" r="1.1" />
      <circle cx="15.5" cy="9.5" r="1.1" />
    </SelectIcon>
  );
}

/**
 * A circle with one half filled, which is the conventional contrast glyph.
 *
 * The filled half is the one thing in this app's icons that is not a stroke, and it has to be:
 * light against dark IS the difference between the two halves, so an outline of this shape
 * would be a plain circle. It carries its own fill rather than the svg doing it, so every other
 * stroke in here still inherits `fill="none"` from the wrapper.
 */
function ContrastIcon(): ReactElement {
  return (
    <SelectIcon name="contrast">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </SelectIcon>
  );
}

/** One option: the value that comes back, and the words a reader picks it by. */
interface SelectOption {
  value: string;
  label: string;
}

interface LabelledSelectProps {
  /** The control's own id. The label points at it, and its label's id is derived from it. */
  id: string;
  label: string;
  /** The glyph drawn over the select's left padding, which is what a reader sees instead. */
  icon: ReactNode;
  /** The tooltip, which is the whole of what a sighted mouse user has to go on. */
  title: string;
  value: string;
  options: readonly SelectOption[];
  /**
   * The raw value the reader picked. Raw because a select hands back a string and only the
   * caller knows what a valid one of those is.
   */
  onPick(value: string): void;
}

/**
 * A select with an icon over it and its label hidden.
 *
 * THE LABEL IS STILL A LABEL ELEMENT, not an aria-label and not a placeholder option. It is
 * visually hidden rather than dropped: that keeps the label and control pairing the markup
 * already had, which is what a screen reader reads out and what more of the assistive tech
 * outside that one category understands, where an aria-label would replace an element with an
 * attribute and hand the same name to strictly less of it.
 *
 * What the hiding buys is the ROW. A label above each select made this group two rows tall
 * while the other two groups of the settings bar were one, and that is the whole reason the bar
 * could not sit on a single line. What replaces it on screen is a glyph plus a tooltip, which
 * is the pattern the self view mic and camera already use.
 *
 * Hook free on purpose, like SelfControlButton: the tests call it as an ordinary function and
 * read the element it hands back.
 */
function LabelledSelect({
  id,
  label,
  icon,
  title,
  value,
  options,
  onPick,
}: LabelledSelectProps): ReactElement {
  return (
    <SelectShell className="theme-field">
      <label className="visually-hidden" id={labelIdFor(id)} htmlFor={id}>
        {label}
      </label>
      {/* Immediately before the select, because the stylesheet pads the option text clear of it
          with `.select-icon + select`. An icon anywhere else in here is an icon over text. */}
      {icon}
      <select id={id} value={value} title={title} onChange={(event) => onPick(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </SelectShell>
  );
}

export interface ThemePickerViewProps {
  theme: ThemeChoice;
  /** Passed in rather than read from a hook, so this whole view is callable from a test. */
  copy: Copy;
  onChoose(change: Partial<ThemeChoice>): void;
}

/**
 * The theme controls in the settings drawer: which palette, and light against dark.
 *
 * Group two of the settings bar, between the language controls and the two ways out. Hook free,
 * with the choice and the copy handed in, which is what keeps it callable from the node suite;
 * Room reads the store and passes both down, so nothing here has to know where they came from.
 *
 * Two controls rather than one list of twenty, because they are two independent choices. Picking
 * Harbor should not also decide whether the room you are sitting in is dark, and switching the
 * lights off in the evening should not cost you the palette you picked.
 *
 * SIDE BY SIDE, and both the same kind of control, by owner decision after looking at the real
 * drawer: a select over a fieldset of radio pills read as two unrelated settings stacked up
 * rather than as one row of controls. Appearance lost the fieldset in that move, and with it a
 * radio group's arrow key navigation. What replaced it is not less accessible, it is a
 * different accessible control: a select is one tab stop with the same arrow keys inside it, it
 * announces its label and its chosen value, and a phone offers it as the same single choice
 * sheet. What a fieldset had and a labelled select does not is a group NAME separate from the
 * control's own, and here those two were the same word anyway.
 *
 * ONE ROW, and no prose. There was a line under the two controls describing the chosen palette
 * ("Light first: warm oat paper, indigo accent"). It went, along with its ten copy keys in
 * every locale, because it made this group two rows tall inside a bar whose other two groups
 * are one: it is the whole reason the bar could not sit on a single line, and the tooltip on
 * the palette select already says what the control does.
 *
 * The theme NAMES are proper nouns and are never translated. Everything else here is.
 */
export function ThemePickerView({ theme, copy, onChoose }: ThemePickerViewProps): ReactElement {
  return (
    // Named by the palette label, which is the same element that named it before the appearance
    // control moved up beside it, and which is hidden rather than gone. "Theme" is still the
    // honest name for a section holding a palette and that palette's light and dark: the
    // alternative is a section with no name at all, since a new heading would be a new word in
    // five files for something already said.
    <section className="theme-picker" aria-labelledby={labelIdFor(PALETTE_ID)}>
      <LabelledSelect
        id={PALETTE_ID}
        label={copy.t("room.theme.label")}
        icon={<PaletteIcon />}
        title={copy.t("room.theme.title")}
        value={theme.paletteId}
        options={THEMES.map((option) => ({ value: option.id, label: option.name }))}
        // The value can only be one of the options, so this is a total function rather than
        // a check for something that happens. It is here because the alternative is a cast,
        // and a cast would also swallow the day somebody renames a palette id.
        onPick={(picked) => {
          if (isPaletteId(picked)) onChoose({ paletteId: picked });
        }}
      />

      <LabelledSelect
        id={MODE_ID}
        label={copy.t("room.theme.appearance")}
        icon={<ContrastIcon />}
        // The control's own name, because there is no second sentence to say about it that its
        // three options do not already say out loud.
        title={copy.t("room.theme.appearance")}
        value={theme.mode}
        options={THEME_MODES.map((mode) => ({ value: mode, label: copy.t(modeKey(mode)) }))}
        onPick={(picked) => {
          if (isThemeMode(picked)) onChoose({ mode: picked });
        }}
      />
    </section>
  );
}
