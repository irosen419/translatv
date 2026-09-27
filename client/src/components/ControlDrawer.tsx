import { useEffect, useState, type ReactNode } from "react";

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

interface Props {
  /** The settings themselves. Rendered only while open, so nothing in here holds focus when shut. */
  children: ReactNode;
}

/**
 * The settings drawer, and the gear that opens it.
 *
 * TAP IS THE WHOLE INTERACTION. There was briefly a drag to resize gesture on a grabber bar; it
 * was tried on a phone and cut. The drawer is content sized against a max height instead, and the
 * grabber went with the gesture rather than staying on as decoration, because a handle that
 * cannot be grabbed is a worse affordance than no handle at all.
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
    <>
      <button
        className={open ? "gear-button open" : "gear-button"}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="control-drawer"
        aria-label={open ? copy.t("room.settings.close") : copy.t("room.settings.open")}
        title={open ? copy.t("room.settings.close") : copy.t("room.settings.title")}
      >
        <GearIcon />
      </button>

      <div
        id="control-drawer"
        className={open ? "control-drawer open" : "control-drawer"}
        // Hidden from assistive tech AND from tab order while shut, because it is only slid off
        // screen rather than unmounted, and an offscreen control is still focusable.
        aria-hidden={!open}
        {...(open ? {} : { inert: "" })}
      >
        <div className="drawer-body">{children}</div>
      </div>
    </>
  );
}
