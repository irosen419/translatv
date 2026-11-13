import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import type { Copy } from "../i18n/copy.js";
import { useCopy } from "../i18n/useCopy.js";

function GearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export interface DrawerFrameProps {
  open: boolean;
  onToggle(): void;
  /** Passed in rather than read from a hook, so this whole view is callable from a test. */
  copy: Copy;
  /*
   * There is deliberately no gearStyle here any more.
   *
   * The gear used to be handed the VIDEO WELL's palette, because it floated directly over the
   * video on its own black scrim and a light theme would otherwise have put a near black icon
   * on it. It sits in a tab now, and the tab is painted with the PAGE's --surface, so the well's
   * palette became exactly the bug it was added to prevent: the dark half's near white icon on
   * the light half's near white tab, invisible but for the border around it. The gear is page
   * chrome now and takes the page's colours like everything else in the drawer.
   */
  /** The settings themselves. */
  children: ReactNode;
}

/**
 * The drawer's markup: the dock, the gear's row, and the sheet under it.
 *
 * THE GEAR IS HOW THE DRAWER IS OPENED, which is the one constraint everything here is shaped
 * by. It has to stay visible, reachable and focusable while the drawer is shut, so it cannot
 * live inside the sheet: the sheet is slid off screen and marked inert, and a gear in there is
 * hidden from assistive tech and out of the tab order at exactly the moment it is the only way
 * back in.
 *
 * It used to solve that by not being in the drawer at all: it was positioned on .room, floating
 * over the video at the bottom right, and with the drawer open it sat vertically centred over
 * the settings bar. That is what the bar's 62px right gutter was reserving, and space-between
 * then pressed End chat, an irreversible control, flat against that gutter.
 *
 * So the gear is neither in the sheet nor outside the drawer now: it is in a DOCK that holds
 * both it and the sheet. The dock is what slides, and it stops short. Shut, it is translated
 * down by its own height less the gear's row, which leaves exactly that row on screen along the
 * bottom of the video. Open, it is translated to zero and the gear sits above the settings bar,
 * off its line entirely. The gear is at the START of that row, not the end, because the end put
 * it directly over End chat.
 *
 * Three things fall out of that, and they are why this shape was chosen over the alternatives:
 *
 *   1. ONE ELEMENT MOVES. The gear used to carry its own `right` transition so it tracked the
 *      transcript panel on the same curve as the drawer beside it. Two elements animating the
 *      same edge is two chances to disagree about where it is; the dock is one.
 *   2. THE SHUT STATE IS A TAB, NOT A BAR. The dock itself paints nothing in either state, and
 *      the gear's row is only as wide as the gear, so what is left on screen when the sheet
 *      slides away is a small tab holding the gear. A full width row would have been a band of
 *      surface colour across the bottom of the video, permanently, which is a worse thing to
 *      look at than what it fixes.
 *   3. THERE IS STILL ONE GEAR. Drawing a second one inside the drawer would have been the
 *      easy way to get it into the header row, and it would be two tab stops announcing the
 *      same control, drifting apart the first time either was edited.
 *
 * Narrow screens render a header block of their own inside the sheet (the names, the room code
 * and the chips). The gear's row is not that block and does not depend on it: it is its own
 * row, the same height whether there is header content under it or none, which is what makes
 * this work on a wide screen where .drawer-header is absent entirely.
 *
 * Hook free on purpose, like ThemePickerView and DrawerContents: `open` is an argument, so the
 * node suite can ask for both states in the same breath and check the gear survives both.
 */
export function DrawerFrame({
  open,
  onToggle,
  copy,
  children,
}: DrawerFrameProps): ReactElement {
  return (
    <div className={open ? "drawer-dock open" : "drawer-dock"}>
      <div className="drawer-handle">
        <button
          className={open ? "gear-button open" : "gear-button"}
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="control-drawer"
          aria-label={open ? copy.t("room.settings.close") : copy.t("room.settings.open")}
          title={open ? copy.t("room.settings.close") : copy.t("room.settings.title")}
        >
          <GearIcon />
        </button>
      </div>

      <div
        id="control-drawer"
        className={open ? "control-drawer open" : "control-drawer"}
        // Hidden from assistive tech AND from tab order while shut, because it is only slid off
        // screen rather than unmounted, and an offscreen control is still focusable. The gear
        // is outside this element for exactly that reason.
        aria-hidden={!open}
        {...(open ? {} : { inert: "" })}
      >
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}

interface Props {
  /** The settings themselves. Rendered only while open, so nothing in here holds focus when shut. */
  children: ReactNode;
}

/**
 * The settings drawer, and the gear that opens it.
 *
 * The state and the keyboard live here; the markup is DrawerFrame above, which is hook free so
 * the suite can call it. TAP IS THE WHOLE INTERACTION. There was briefly a drag to resize
 * gesture on a grabber bar; it was tried on a phone and cut. The drawer is content sized
 * against a max height instead, and the grabber went with the gesture rather than staying on as
 * decoration, because a handle that cannot be grabbed is a worse affordance than no handle.
 */
export function ControlDrawer({ children }: Props) {
  const [open, setOpen] = useState(false);
  const copy = useCopy();

  // Escape closes it. A panel that covers a third of the screen and can only be dismissed by
  // hitting the same small target that opened it is a trap on a phone.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <DrawerFrame
      open={open}
      onToggle={() => setOpen((v) => !v)}
      copy={copy}
    >
      {children}
    </DrawerFrame>
  );
}
