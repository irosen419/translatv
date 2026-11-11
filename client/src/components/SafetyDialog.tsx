import { useEffect, useRef, useState } from "react";
import { REPORT_DETAILS_MAX, REPORT_REASONS, type ReportReason } from "@translatv/shared";

import type { CopyKey } from "../i18n/copy.js";
import { useCopy } from "../i18n/useCopy.js";
import type { ReportInput, SafetyResult } from "../lib/safety.js";
import { useStore } from "../state/store.js";

/** The two calls this dialog makes, so the call screen and the history list hand in the same thing. */
export interface SafetyActions {
  block(contactId: string): Promise<SafetyResult<unknown>>;
  report(input: ReportInput): Promise<SafetyResult<{ blocked: boolean }>>;
}

interface Props {
  /** Who this is about, as the reader's own contactId, and the name the screen already shows. */
  contactId: string;
  name: string;
  /** Already blocked by this reader: the dialog offers the report only. */
  alreadyBlocked?: boolean;
  actions: SafetyActions;
  /** A block landed (on its own or with a report). In a call, the call is over by now. */
  onBlocked?(): void;
  onClose(): void;
}

type Step =
  | { kind: "form" }
  | { kind: "confirm"; then: "block" | "reportAndBlock" }
  | { kind: "done"; message: CopyKey };

function failureKey(error: string): CopyKey {
  if (error === "CONTACT_NOT_FOUND") return "safety.error.CONTACT_NOT_FOUND";
  if (error === "RATE_LIMITED") return "safety.error.RATE_LIMITED";
  return "safety.error.failed";
}

/**
 * Report or block one person: from the drawer in a call, or from a call in the history list.
 *
 * A modal <dialog>, like the End chat and correction dialogs: showModal traps focus inside it and
 * Escape closes it, and closing hands focus back to whatever opened it. Each step moves focus to
 * its own heading, so a screen reader hears where it is rather than the page it left.
 *
 * Blocking always asks first, whichever way it is reached (the Block button, or a report with
 * "Also block" ticked), because it ends a call in progress and is not undone from here.
 */
export function SafetyDialog({ contactId, name, alreadyBlocked = false, actions, onBlocked, onClose }: Props) {
  const copy = useCopy();
  const supportEmail = useStore((state) => state.supportEmail);
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<CopyKey | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal?.();
  }, []);

  // A new step replaces what had focus; its heading is the stable place to land.
  useEffect(() => {
    heading.current?.focus();
  }, [step.kind]);

  const params = { name };

  async function runBlock(): Promise<void> {
    setBusy(true);
    setProblem(null);
    const result = await actions.block(contactId).catch(() => ({ ok: false as const, error: "NETWORK" as const }));
    setBusy(false);
    if (!result.ok) {
      setProblem(failureKey(result.error));
      return;
    }
    setStep({ kind: "done", message: "safety.done.blocked" });
    onBlocked?.();
  }

  async function runReport(block: boolean): Promise<void> {
    if (reason === null) {
      setProblem("safety.report.pickReason");
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await actions
      .report({ contactId, reason, details, alsoBlock: block })
      .catch(() => ({ ok: false as const, error: "NETWORK" as const }));
    setBusy(false);
    if (!result.ok) {
      setProblem(failureKey(result.error));
      if (step.kind === "confirm") setStep({ kind: "form" });
      return;
    }
    setStep({ kind: "done", message: block ? "safety.done.reportedAndBlocked" : "safety.done.reported" });
    if (block) onBlocked?.();
  }

  const problemLine = problem ? (
    <p id="safety-problem" className="hint bad" role="alert">
      {copy.t(problem)}
    </p>
  ) : null;

  return (
    <dialog
      ref={ref}
      className="safety-dialog"
      aria-labelledby="safety-step-title"
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      {step.kind === "done" && (
        <>
          <h2 id="safety-step-title" ref={heading} tabIndex={-1}>
            {copy.t("safety.title", params)}
          </h2>
          <p className="safety-done" role="status">
            {copy.t(step.message, params)}
          </p>
          {supportEmail && (
            <p>
              {copy.t("safety.support.lead")} <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
            </p>
          )}
          <div className="safety-actions">
            <button type="button" className="primary" onClick={() => ref.current?.close()}>
              {copy.t("safety.close")}
            </button>
          </div>
        </>
      )}

      {step.kind === "confirm" && (
        <>
          <h2 id="safety-step-title" ref={heading} tabIndex={-1}>
            {copy.t("safety.confirm.title", params)}
          </h2>
          <p>{copy.t("safety.confirm.body")}</p>
          {problemLine}
          <div className="safety-actions">
            <button type="button" disabled={busy} onClick={() => setStep({ kind: "form" })}>
              {copy.t("safety.cancel")}
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void (step.then === "block" ? runBlock() : runReport(true))}
            >
              {copy.t(step.then === "block" ? "safety.confirm.block" : "safety.confirm.reportAndBlock")}
            </button>
          </div>
        </>
      )}

      {step.kind === "form" && (
        <>
          <h2 id="safety-step-title" ref={heading} tabIndex={-1}>
            {copy.t("safety.title", params)}
          </h2>

          <section className="safety-section" aria-labelledby="safety-block-heading">
            <h3 id="safety-block-heading">{copy.t("safety.block.heading")}</h3>
            {alreadyBlocked ? (
              <p>{copy.t("safety.block.already", params)}</p>
            ) : (
              <>
                <p>{copy.t("safety.block.lead", params)}</p>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    setProblem(null);
                    setStep({ kind: "confirm", then: "block" });
                  }}
                >
                  {copy.t("safety.block.button", params)}
                </button>
              </>
            )}
          </section>

          <form
            className="safety-section"
            aria-labelledby="safety-report-heading"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              if (reason === null) {
                setProblem("safety.report.pickReason");
                return;
              }
              if (alsoBlock && !alreadyBlocked) {
                setProblem(null);
                setStep({ kind: "confirm", then: "reportAndBlock" });
                return;
              }
              void runReport(false);
            }}
          >
            <h3 id="safety-report-heading">{copy.t("safety.report.heading")}</h3>
            <p>{copy.t("safety.report.lead", params)}</p>
            <fieldset className="safety-reasons" aria-describedby={problem === "safety.report.pickReason" ? "safety-problem" : undefined}>
              <legend>{copy.t("safety.report.reason")}</legend>
              {REPORT_REASONS.map((option) => (
                <label key={option} className="safety-choice">
                  <input
                    type="radio"
                    name="safety-reason"
                    value={option}
                    checked={reason === option}
                    onChange={() => {
                      setReason(option);
                      if (problem === "safety.report.pickReason") setProblem(null);
                    }}
                  />
                  <span>{copy.t(`safety.reason.${option}`)}</span>
                </label>
              ))}
            </fieldset>
            <div className="field">
              <label htmlFor="safety-details">{copy.t("safety.report.details")}</label>
              <textarea
                id="safety-details"
                value={details}
                maxLength={REPORT_DETAILS_MAX}
                rows={3}
                aria-describedby="safety-details-count"
                onChange={(event) => setDetails(event.target.value.slice(0, REPORT_DETAILS_MAX))}
              />
              <p id="safety-details-count" className="hint">
                {copy.t("safety.report.count", { count: details.length, max: REPORT_DETAILS_MAX })}
              </p>
            </div>
            {!alreadyBlocked && (
              <label className="safety-choice">
                <input type="checkbox" checked={alsoBlock} onChange={(event) => setAlsoBlock(event.target.checked)} />
                <span>{copy.t("safety.report.alsoBlock", params)}</span>
              </label>
            )}
            {problemLine}
            <div className="safety-actions">
              <button type="button" disabled={busy} onClick={() => ref.current?.close()}>
                {copy.t("safety.cancel")}
              </button>
              <button type="submit" className="primary" disabled={busy}>
                {copy.t("safety.report.send")}
              </button>
            </div>
          </form>
        </>
      )}
    </dialog>
  );
}
