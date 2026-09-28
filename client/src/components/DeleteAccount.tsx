import { useEffect, useRef, useState } from "react";
import type { AuthFailure, AuthOutcome } from "../lib/session.js";
import type { CopyKey } from "../i18n/copy.js";
import { useCopy } from "../i18n/useCopy.js";

/**
 * The sentence for a refused deletion. A wrong password gets its own sentence, because the sign in
 * one ("that email and password do not match an account") names an email nobody typed here.
 * Anything without a specific sentence reads as "could not reach the server", as on AuthScreen.
 */
function failureKey(error: AuthFailure): CopyKey {
  switch (error) {
    case "INVALID_CREDENTIALS":
      return "account.delete.wrongPassword";
    case "LOCKED":
    case "RATE_LIMITED":
      return `auth.error.${error}`;
    default:
      return "auth.error.unavailable";
  }
}

interface Props {
  /** Resolves when the server has answered. On success the session is already gone. */
  onDelete(password: string): Promise<AuthOutcome>;
}

/**
 * Deleting the account, behind a second step and the password. Closed, it is one quiet link in the
 * account strip; open, it says what goes, what stays, and asks for the password again.
 */
export function DeleteAccount({ onDelete }: Props) {
  const copy = useCopy();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  // Opening swaps the focused button for the form and Cancel swaps it back, and focus left in a
  // node that is gone falls to <body>: a keyboard user was dropped at the top of the page both
  // ways. Opening moves focus to the password field (autoFocus below), cancelling to this button.
  const openButton = useRef<HTMLButtonElement>(null);
  const focusOpenButton = useRef(false);
  // After a refusal, back to the field, selected, ready to retype. The submit button is disabled
  // while the request runs, and a disabled button drops the focus it had to <body>.
  const passwordField = useRef<HTMLInputElement>(null);
  const retype = () => {
    passwordField.current?.focus();
    passwordField.current?.select();
  };
  useEffect(() => {
    if (open || !focusOpenButton.current) return;
    focusOpenButton.current = false;
    openButton.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <button ref={openButton} type="button" className="linklike" onClick={() => setOpen(true)}>
        {copy.t("account.delete.open")}
      </button>
    );
  }

  return (
    <form
      className="delete-account"
      onSubmit={(event) => {
        event.preventDefault();
        if (password === "" || busy) return;
        setBusy(true);
        setFailure(null);
        void onDelete(password)
          .then((outcome) => {
            if (outcome.ok) return;
            setFailure(outcome.error);
            retype();
          })
          .catch(() => {
            setFailure("NETWORK");
            retype();
          })
          .finally(() => setBusy(false));
      }}
    >
      <h2 className="auth-title">{copy.t("account.delete.title")}</h2>
      <p className="hint">{copy.t("account.delete.lead")}</p>
      <div className="field">
        <label htmlFor="delete-password">{copy.t("account.delete.password")}</label>
        <input
          id="delete-password"
          ref={passwordField}
          autoFocus
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {failure && <p className="hint bad" role="alert">{copy.t(failureKey(failure))}</p>}
      <div className="delete-actions">
        <button
          type="button"
          onClick={() => {
            focusOpenButton.current = true;
            setOpen(false);
            setPassword("");
            setFailure(null);
          }}
        >
          {copy.t("account.delete.cancel")}
        </button>
        <button type="submit" className="danger" disabled={password === "" || busy}>
          {copy.t("account.delete.confirm")}
        </button>
      </div>
    </form>
  );
}
