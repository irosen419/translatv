import { useState } from "react";
import {
  canonicalInvite,
  formatInviteInput,
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_GROUP_LENGTH,
  INVITE_GROUPS,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RULES,
  unmetPasswordRules,
  type SignupMode,
} from "@translatv/shared";
import { useCopy } from "../i18n/useCopy.js";
import { SiteLinks } from "./InfoPage.jsx";
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
  const [showPassword, setShowPassword] = useState(false);

  const needsInvite = signupMode === "invite";
  // The rules are checked on sign up only. Sign in never asks, so an account made under an older
  // rule still gets in.
  const unmet = new Set(unmetPasswordRules(password));
  const ready =
    email.trim().length > 0 &&
    password.length > 0 &&
    (mode === "signIn" ||
      (displayName.trim().length > 0 && unmet.size === 0 && (!needsInvite || canonicalInvite(invite) !== null)));

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
    setShowPassword(false);
  }

  return (
    <div className="center">
      <div className="card">
        <h1>{copy.t("landing.title")}</h1>
        <p className="sub">{copy.t("auth.sub")}</p>

        {/* Announced, like the form's own refusal below: it says why a call ended here. */}
        {error && (
          <div className="notice bad" role="alert">
            {copy.ref(error)}
          </div>
        )}

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
              {/* Masked to the code's own shape (shared/src/auth.ts): typed lowercase shows as
                  uppercase, a lookalike (O, I, L, U) as the character codes really have, the
                  dashes are added, and anything else is dropped. The server sanitizes again. */}
              <input
                id="auth-invite"
                className="invite-input"
                value={invite}
                onChange={(event) => setInvite(formatInviteInput(event.target.value))}
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                maxLength={INVITE_CODE_LENGTH + INVITE_GROUPS - 1}
                placeholder={Array.from({ length: INVITE_GROUPS }, () => "X".repeat(INVITE_GROUP_LENGTH)).join("-")}
                pattern={`[${INVITE_ALPHABET}]{${INVITE_GROUP_LENGTH}}(-[${INVITE_ALPHABET}]{${INVITE_GROUP_LENGTH}}){${INVITE_GROUPS - 1}}`}
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
            <div className="password-shell">
              <input
                id="auth-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "signIn" ? "current-password" : "new-password"}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-describedby={mode === "signUp" ? "auth-password-rules" : undefined}
              />
              <button
                type="button"
                className="password-eye"
                aria-pressed={showPassword}
                aria-label={copy.t(showPassword ? "auth.password.hide" : "auth.password.show")}
                title={copy.t(showPassword ? "auth.password.hide" : "auth.password.show")}
                onClick={() => setShowPassword((shown) => !shown)}
              >
                <EyeIcon open={!showPassword} />
              </button>
            </div>
            {mode === "signUp" && (
              <div id="auth-password-rules" className="password-rules">
                <p className="hint">{copy.t("auth.password.rules")}</p>
                <ul>
                  {PASSWORD_RULES.map((rule) => {
                    const met = !unmet.has(rule);
                    return (
                      <li key={rule} data-rule={rule} className={met ? "met" : undefined}>
                        <span className="rule-mark" aria-hidden="true" />
                        <span className="visually-hidden">
                          {copy.t(met ? "auth.password.rule.met" : "auth.password.rule.unmet")}
                        </span>
                        {copy.t(`auth.password.rule.${rule}`, { min: MIN_PASSWORD_LENGTH })}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          {failure && (
            <div className="notice bad" role="alert">
              {copy.t(failureKey(failure))}
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
        <SiteLinks />
      </div>
    </div>
  );
}

/**
 * The show and hide glyph: an eye while the password is hidden (press to see it), and the same eye
 * struck through while it is shown. currentColor, so it follows the theme.
 */
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <path d="M4 4l16 16" />}
    </svg>
  );
}
