import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BlockedPerson, CallRecord, OwnerReport } from "@translatv/shared";

import type { CopyKey } from "../i18n/copy.js";
import { useCopy } from "../i18n/useCopy.js";
import type { SafetyApi } from "../lib/safety.js";
import { useStore } from "../state/store.js";
import { SafetyDialog } from "./SafetyDialog.jsx";

/**
 * The account page's safety panels: recent calls (each with Report or block), the people this
 * account blocked (each with Unblock), and, for the owner alone, the reports to review.
 *
 * Each is one quiet link in the account strip that opens in place, like Saved corrections beside
 * it: opening loads fresh, every time, and swapping the link for the panel and back moves focus
 * to the panel's heading and back to the link, so a keyboard user is never dropped on <body>.
 */

/** A date and time in the reader's own dialect, which is what the interface is in. */
function useWhen(): (epochMs: number) => string {
  const dialect = useStore((state) => state.uiDialect);
  return (epochMs) => {
    try {
      return new Intl.DateTimeFormat(dialect, { dateStyle: "medium", timeStyle: "short" }).format(epochMs);
    } catch {
      return new Date(epochMs).toISOString();
    }
  };
}

/** The open and close half every panel shares: the link, the heading, and where focus goes. */
function Panel({
  id,
  openLabel,
  title,
  closeLabel,
  className,
  children,
  onOpen,
}: {
  id: string;
  openLabel: string;
  title: string;
  closeLabel: string;
  className: string;
  children: ReactNode;
  onOpen(): void;
}) {
  const [open, setOpen] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusOpenButton = useRef(false);

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
      <button
        ref={openButton}
        type="button"
        className="linklike"
        onClick={() => {
          onOpen();
          setOpen(true);
        }}
      >
        {openLabel}
      </button>
    );
  }

  return (
    <section className={`account-panel ${className}`} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="auth-title" ref={heading} tabIndex={-1}>
        {title}
      </h2>
      {children}
      <div className="saved-actions">
        <button
          type="button"
          onClick={() => {
            focusOpenButton.current = true;
            setOpen(false);
          }}
        >
          {closeLabel}
        </button>
      </div>
    </section>
  );
}

function Problem({ message }: { message: CopyKey | null }) {
  const copy = useCopy();
  if (!message) return null;
  return (
    <p className="hint bad" role="alert">
      {copy.t(message)}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Recent calls
// ---------------------------------------------------------------------------

export function RecentCalls({ api }: { api: SafetyApi }) {
  const copy = useCopy();
  const when = useWhen();
  const [calls, setCalls] = useState<CallRecord[] | null>(null);
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<CopyKey | null>(null);
  const [reporting, setReporting] = useState<{ contactId: string; name: string } | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (generation === 0) return;
    let cancelled = false;
    setCalls(null);
    setProblem(null);
    void Promise.all([api.calls(), api.blocks()]).then(([page, blocks]) => {
      if (cancelled) return;
      if (!page.ok) {
        setProblem("history.loadFailed");
        return;
      }
      setCalls(page.value.calls);
      setBlocked(new Set(blocks.ok ? blocks.value.blocked.map((b) => b.contactId) : []));
    });
    return () => {
      cancelled = true;
    };
  }, [api, generation]);

  return (
    <Panel
      id="history"
      className="recent-calls"
      openLabel={copy.t("history.open")}
      title={copy.t("history.title")}
      closeLabel={copy.t("history.close")}
      onOpen={() => setGeneration((n) => n + 1)}
    >
      <Problem message={problem} />
      {calls === null && problem === null && (
        <p className="hint" role="status">
          {copy.t("history.loading")}
        </p>
      )}
      {calls !== null && calls.length === 0 && <p className="hint">{copy.t("history.empty")}</p>}
      {calls !== null && calls.length > 0 && (
        <ul className="saved-list">
          {calls.map((call) => {
            const peer = call.peer;
            const isBlocked = peer !== null && blocked.has(peer.contactId);
            return (
              <li className="saved-item" key={call.id}>
                <div className="saved-text">
                  <div className="saved-source">{peer ? peer.displayName : copy.t("history.nobody")}</div>
                  <div className="saved-target">
                    <time dateTime={new Date(call.startedAt).toISOString()}>{when(call.startedAt)}</time>
                    {isBlocked && <span className="history-blocked"> · {copy.t("history.blocked")}</span>}
                  </div>
                </div>
                {peer && (
                  <button
                    type="button"
                    aria-label={copy.t("safety.openLabel", { name: peer.displayName })}
                    onClick={() => setReporting({ contactId: peer.contactId, name: peer.displayName })}
                  >
                    {copy.t("safety.open")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {reporting && (
        <SafetyDialog
          contactId={reporting.contactId}
          name={reporting.name}
          alreadyBlocked={blocked.has(reporting.contactId)}
          actions={api}
          onBlocked={() => setBlocked((current) => new Set([...current, reporting.contactId]))}
          onClose={() => setReporting(null)}
        />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Blocked people
// ---------------------------------------------------------------------------

export function BlockedPeople({ api }: { api: SafetyApi }) {
  const copy = useCopy();
  const [people, setPeople] = useState<BlockedPerson[] | null>(null);
  const [problem, setProblem] = useState<CopyKey | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const listHeading = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (generation === 0) return;
    let cancelled = false;
    setPeople(null);
    setProblem(null);
    setNotice(null);
    void api.blocks().then((result) => {
      if (cancelled) return;
      if (result.ok) setPeople(result.value.blocked);
      else setProblem("blocked.loadFailed");
    });
    return () => {
      cancelled = true;
    };
  }, [api, generation]);

  function unblock(person: BlockedPerson): void {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setNotice(null);
    void api
      .unblock(person.contactId)
      .then((result) => {
        if (!result.ok) {
          setProblem("blocked.unblockFailed");
          return;
        }
        setPeople(result.value.blocked);
        setNotice(copy.t("blocked.unblocked", { name: person.displayName }));
        // The button that had focus went with its row; the status line says what happened.
        listHeading.current?.focus();
      })
      .finally(() => setBusy(false));
  }

  return (
    <Panel
      id="blocked"
      className="blocked-people"
      openLabel={copy.t("blocked.open")}
      title={copy.t("blocked.title")}
      closeLabel={copy.t("blocked.close")}
      onOpen={() => setGeneration((n) => n + 1)}
    >
      <p className="hint">{copy.t("blocked.lead")}</p>
      <Problem message={problem} />
      <p className="hint good" role="status" ref={listHeading} tabIndex={-1}>
        {notice ?? ""}
      </p>
      {people === null && problem === null && <p className="hint">{copy.t("history.loading")}</p>}
      {people !== null && people.length === 0 && <p className="hint">{copy.t("blocked.empty")}</p>}
      {people !== null && people.length > 0 && (
        <ul className="saved-list">
          {people.map((person) => (
            <li className="saved-item" key={person.contactId}>
              <div className="saved-text">
                <div className="saved-source">{person.displayName}</div>
              </div>
              <button
                type="button"
                disabled={busy}
                aria-label={copy.t("blocked.unblockLabel", { name: person.displayName })}
                onClick={() => unblock(person)}
              >
                {copy.t("blocked.unblock")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The owner's reports
// ---------------------------------------------------------------------------

/**
 * The owner's list of reports, and a way to mark one reviewed. Nothing else: no moderation
 * tooling beyond reading them. Shown only to the owner, and the server refuses anyone else
 * whatever this screen shows.
 */
export function OwnerReports({ api }: { api: SafetyApi }) {
  const copy = useCopy();
  const when = useWhen();
  const [reports, setReports] = useState<OwnerReport[] | null>(null);
  const [problem, setProblem] = useState<CopyKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (generation === 0) return;
    let cancelled = false;
    setReports(null);
    setProblem(null);
    void api.ownerReports().then((result) => {
      if (cancelled) return;
      if (result.ok) setReports(result.value.reports);
      else setProblem("reports.loadFailed");
    });
    return () => {
      cancelled = true;
    };
  }, [api, generation]);

  function review(id: string): void {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    void api
      .review(id)
      .then((result) => {
        if (!result.ok) {
          setProblem("reports.reviewFailed");
          return;
        }
        setReports((current) => current?.map((r) => (r.id === id ? result.value : r)) ?? null);
      })
      .finally(() => setBusy(false));
  }

  const party = (value: OwnerReport["reporter"]) => value?.displayName ?? copy.t("reports.deletedAccount");

  return (
    <Panel
      id="reports"
      className="owner-reports"
      openLabel={copy.t("reports.open")}
      title={copy.t("reports.title")}
      closeLabel={copy.t("reports.close")}
      onOpen={() => setGeneration((n) => n + 1)}
    >
      <Problem message={problem} />
      {reports === null && problem === null && <p className="hint">{copy.t("history.loading")}</p>}
      {reports !== null && reports.length === 0 && <p className="hint">{copy.t("reports.empty")}</p>}
      {reports !== null && reports.length > 0 && (
        <ul className="saved-list">
          {reports.map((report) => (
            <li className="saved-item report-item" key={report.id} data-report-id={report.id}>
              <div className="saved-text">
                <div className="saved-source">
                  {copy.t(`safety.reason.${report.reason}`)} · {copy.t(`reports.status.${report.status}`)}
                </div>
                <div className="saved-target">
                  <time dateTime={new Date(report.createdAt).toISOString()}>{when(report.createdAt)}</time>
                </div>
                <div className="saved-target">
                  {copy.t("reports.from", { name: party(report.reporter) })} · {copy.t("reports.about", { name: party(report.reported) })}
                </div>
                <div className="report-details">{report.details ?? copy.t("reports.noDetails")}</div>
              </div>
              {report.status === "open" && (
                <button type="button" disabled={busy} onClick={() => review(report.id)}>
                  {copy.t("reports.markReviewed")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
