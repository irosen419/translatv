import { useEffect, useRef, useState } from "react";
import type { GlossaryEntry } from "@translatv/shared";
import type { CopyKey } from "../i18n/copy.js";
import { useCopy } from "../i18n/useCopy.js";

/** The two calls this needs, so a test or another screen can hand in something else. */
export interface SavedCorrectionsApi {
  load(): Promise<GlossaryEntry[] | null>;
  remove(entry: GlossaryEntry): Promise<GlossaryEntry[] | null>;
}

/**
 * The person's saved corrections, each with a delete (owner decision C5, 2026-10-09).
 *
 * Corrections are screened by rules when a call ends, and rules cannot see a flipped meaning
 * ("sí" saved as "no"). This list is the backstop: everything saved, readable in full, and one
 * click from gone. It lives on the start page, in the account strip beside deleting the account,
 * because it is something the account holds, and because the start page is the one screen a
 * phone shows in full (the in call panel, where corrections are MADE, is wide screens only).
 *
 * Closed, it is one quiet link; open, it loads the list fresh, every time, so what it shows is
 * what the next call will use.
 */
export function SavedCorrections({ api }: { api: SavedCorrectionsApi }) {
  const copy = useCopy();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<GlossaryEntry[] | null>(null);
  const [problem, setProblem] = useState<CopyKey | null>(null);
  const [busy, setBusy] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusOpenButton = useRef(false);

  // Load on open. A list read before a call ended would hide what that call saved.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEntries(null);
    setProblem(null);
    void api.load().then((list) => {
      if (cancelled) return;
      if (list === null) setProblem("saved.loadFailed");
      else setEntries(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  // Swapping the link for the panel, and back, would otherwise drop focus on <body>.
  useEffect(() => {
    if (open) {
      heading.current?.focus();
      return;
    }
    if (!focusOpenButton.current) return;
    focusOpenButton.current = false;
    openButton.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <button ref={openButton} type="button" className="linklike" onClick={() => setOpen(true)}>
        {copy.t("saved.open")}
      </button>
    );
  }

  function remove(entry: GlossaryEntry): void {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    void api
      .remove(entry)
      .then((list) => {
        if (list === null) {
          setProblem("saved.deleteFailed");
          return;
        }
        setEntries(list);
        // The button that had focus is gone with its entry. The heading is the stable place to
        // land, and reading it again says where the person is.
        heading.current?.focus();
      })
      .finally(() => setBusy(false));
  }

  return (
    <section className="saved-corrections" aria-labelledby="saved-title">
      <h2 id="saved-title" className="auth-title" ref={heading} tabIndex={-1}>
        {copy.t("saved.title")}
      </h2>
      <p className="hint">{copy.t("saved.lead")}</p>

      {problem && (
        <p className="hint bad" role="alert">
          {copy.t(problem)}
        </p>
      )}

      {entries === null && problem === null && (
        <p className="hint" role="status">
          {copy.t("saved.loading")}
        </p>
      )}

      {entries !== null && entries.length === 0 && <p className="hint">{copy.t("saved.empty")}</p>}

      {entries !== null && entries.length > 0 && (
        <ul className="saved-list">
          {entries.map((entry) => (
            <li
              className="saved-item"
              key={`${entry.sourceDialect}|${entry.targetDialect}|${entry.source}|${entry.target}`}
            >
              <div className="saved-text">
                <div className="saved-source" lang={entry.sourceDialect}>
                  {entry.source}
                </div>
                <div className="saved-target" lang={entry.targetDialect}>
                  {entry.target}
                </div>
              </div>
              <button
                type="button"
                className="danger"
                disabled={busy}
                aria-label={copy.t("saved.deleteLabel", { source: entry.source })}
                onClick={() => remove(entry)}
              >
                {copy.t("saved.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="saved-actions">
        <button
          type="button"
          onClick={() => {
            focusOpenButton.current = true;
            setOpen(false);
          }}
        >
          {copy.t("saved.close")}
        </button>
      </div>
    </section>
  );
}
