import { useState } from "react";
import { MIN_PASSWORD_LENGTH, type SignupMode } from "@translatv/shared";
import { useCopy } from "../i18n/useCopy.js";
import type { CopyKey, CopyRef } from "../i18n/copy.js";
import type { AuthFailure, AuthOutcome } from "../lib/session.js";

interface Props {
  /** Whether signing up needs an invite code, from /healthz. */
  signupMode: SignupMode;
  /** Why the last attempt to reach a room failed, when that is what sent someone here. */
  error: CopyRef | null;
  onSignIn(email: string, password: string): Promise<AuthOutcome>;
  onSignUp(input: { invite?: string; email: string; password: string; displayName: string }): Promise<AuthOutcome>;
}

/**
 * The sentence for a refusal. The server sends codes only (shared/src/auth.ts); the words are
 * chosen here, in the reader's language. Anything this screen has no specific sentence for (a
 * code only another endpoint returns, or NETWORK) reads as "could not reach the server", which is
 * the one answer that never tells someone their correct password was wrong.
 */
function failureKey(error: AuthFailure): CopyKey {
  switch (error) {
    case "INVALID_INPUT":
    case "WEAK_PASSWORD":
    case "INVITE_INVALID":
    case "EMAIL_TAKEN":
    case "INVALID_CREDENTIALS":
    case "LOCKED":
    case "RATE_LIMITED":
      return `auth.error.${error}`;
    default:
      return "auth.error.unavailable";
  }
}

/**
 * Sign in, or create an account.
 *
 * Shown instead of the landing page to anyone with no session, including someone who followed a
 * /r/<code> link: joining needs an account too, and the room code is kept while they sign in.
 *
 * Every field is dropped from state once it has been sent. A password left in a React tree lives
 * for the life of the tab.
 */
export function AuthScreen({ signupMode, error, onSignIn, onSignUp }: Props) {
  const copy = useCopy();
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [invite, setInvite] = useState("");
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const needsInvite = signupMode === "invite";
  const ready =
    email.trim().length > 0 &&
    password.length > 0 &&
    (mode === "signIn" || (displayName.trim().length > 0 && (!needsInvite || invite.trim().length > 0)));

  function submit(): void {
    if (!ready || submitting) return;
    setSubmitting(true);
    setFailure(null);
    const attempt =
      mode === "signIn"
        ? onSignIn(email, password)
        : onSignUp({
            ...(needsInvite ? { invite } : {}),
            email,
            password,
            displayName,
          });
    void attempt
      .then((outcome) => {
        setPassword("");
        if (!outcome.ok) setFailure(outcome.error);
      })
      .catch(() => {
        setPassword("");
        setFailure("NETWORK");
      })
      .finally(() => setSubmitting(false));
  }

  function switchTo(next: "signIn" | "signUp"): void {
    setMode(next);
    setFailure(null);
    setPassword("");
  }

  return (
    <div className="center">
      <div className="card">
        <h1>{copy.t("landing.title")}</h1>
        <p className="sub">{copy.t("auth.sub")}</p>

        {error && <div className="notice bad">{copy.ref(error)}</div>}

        <h2 className="auth-title">{copy.t(mode === "signIn" ? "auth.title.signIn" : "auth.title.signUp")}</h2>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {mode === "signUp" && needsInvite && (
            <div className="field">
              <label htmlFor="auth-invite">{copy.t("auth.invite")}</label>
              <input
                id="auth-invite"
                value={invite}
                onChange={(event) => setInvite(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                style={{ fontFamily: "ui-monospace, monospace", letterSpacing: "0.08em" }}
              />
              <p className="hint">{copy.t("auth.invite.hint")}</p>
            </div>
          )}

          {mode === "signUp" && (
            <div className="field">
              <label htmlFor="auth-name">{copy.t("auth.displayName")}</label>
              <input
                id="auth-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                maxLength={24}
              />
              <p className="hint">{copy.t("auth.displayName.hint")}</p>
            </div>
          )}

          <div className="field">
            <label htmlFor="auth-email">{copy.t("auth.email")}</label>
            <input
              id="auth-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label htmlFor="auth-password">{copy.t("auth.password")}</label>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
            />
            {mode === "signUp" && (
              <p className="hint">{copy.t("auth.password.hint", { min: MIN_PASSWORD_LENGTH })}</p>
            )}
          </div>

          {failure && (
            <div className="notice bad" role="alert">
              {copy.t(failureKey(failure), { min: MIN_PASSWORD_LENGTH })}
            </div>
          )}

          <button type="submit" className="primary" disabled={!ready || submitting} style={{ width: "100%" }}>
            {copy.t(mode === "signIn" ? "auth.submit.signIn" : "auth.submit.signUp")}
          </button>
        </form>

        <div className="account-strip">
          <button
            type="button"
            className="linklike"
            onClick={() => switchTo(mode === "signIn" ? "signUp" : "signIn")}
          >
            {copy.t(mode === "signIn" ? "auth.switch.toSignUp" : "auth.switch.toSignIn")}
          </button>
        </div>
      </div>
    </div>
  );
}
