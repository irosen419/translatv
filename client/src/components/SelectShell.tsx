import type { ReactElement, ReactNode } from "react";

/**
 * The chevron every select in this app draws for itself.
 *
 * `appearance: none` is what makes a select look like the rest of the stylesheet rather than
 * like whatever the OS draws, and it is also what takes the browser's own arrow away. So the
 * arrow comes back here, at the 12px inset styles.css pads the option text clear of.
 *
 * Same house style as the gear in ControlDrawer and the self view icons in Room: a 24 unit
 * viewBox, no fill, currentColor strokes, drawn here rather than pulled from a library so the
 * app still takes no icon dependency. It differs from those in ONE way, deliberately: it
 * carries no width or height attribute, because its size is part of an arithmetic the
 * stylesheet owns (the padding that keeps "English (United States)" from running underneath
 * it), and a size declared in two places is a size that can disagree with itself.
 *
 * Drawn as a real element rather than as a `data:` URI background image. A URI encoded copy of
 * a glyph in a stylesheet is a second place to edit it, it cannot inherit currentColor, and it
 * would be the one icon in this app nobody could find by searching for the shape.
 */
function SelectChevron(): ReactElement {
  return (
    <svg
      className="select-chevron"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon="chevron"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export interface SelectShellProps {
  /** What this shell is, on top of being one: a layout class for the select's own context. */
  className?: string;
  /**
   * The control, and anything drawn OVER it: its label, and a leading icon if it has one.
   *
   * A leading icon has to sit immediately before the select, because the stylesheet pads the
   * text clear of it with `.select-icon + select` and an icon anywhere else is an icon drawn
   * over text.
   */
  children: ReactNode;
}

/**
 * The box a select sits in, so something can be drawn over it.
 *
 * A NATIVE SELECT CANNOT CONTAIN AN ELEMENT. Its children are its options, and nothing else
 * renders inside it, so an icon over a select is a sibling positioned on top of the select's
 * own padding rather than anything inside it. That is all this is: the positioning context, and
 * the chevron that every select needs now that the browser has stopped drawing one.
 *
 * Hook free, like SelfControlButton and ThemePickerView, so the node suite can call it.
 */
export function SelectShell({ className, children }: SelectShellProps): ReactElement {
  return (
    <div className={className ? `select-shell ${className}` : "select-shell"}>
      {children}
      <SelectChevron />
    </div>
  );
}
