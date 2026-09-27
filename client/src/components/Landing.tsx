import { useState } from "react";
import { codeFromShared, isLikelyCode, normalizeCode } from "../lib/code.js";
import { useCopy } from "../i18n/useCopy.js";
import type { CopyRef } from "../i18n/copy.js";

/** Longest thing worth keeping as a typed code, once it is clear it is not a link. */
const MAX_TYPED = 12;

interface Props {
  initialCode: string | null;
  /** Why the last attempt failed, so someone sent back here knows what happened. */
  error: CopyRef | null;
  /** This server gates starting a call. False means no admin is configured and anyone may. */
  adminRequired: boolean;
  /** This browser is holding an admin token. NOT proof: the server decides, this shapes the UI. */
  isAdmin: boolean;
  onCreate(): void;
  onJoin(code: string): void;
  onLogin(password: string): Promise<boolean>;
  onLogout(): void;
}

export function Landing({
  initialCode,
  error,
  adminRequired,
  isAdmin,
  onCreate,
  onJoin,
  onLogin,
  onLogout,
}: Props) {
  // Two different questions. "May I start a call" is answered by the gate being off OR by
  // holding a token; "should this page offer a login at all" is answered by the gate alone.
  // Collapsing them into one flag is what made the ungated server unusable: the button read
  // "no token" as "refused" on a server that refuses nobody.
  const canCreate = !adminRequired || isAdmin;
  const [code, setCode] = useState(initialCode ?? "");
  const ready = isLikelyCode(code);
  const copy = useCopy();
  const [showLogin, setShowLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<"wrong" | "unavailable" | null>(null);
  const [submitting, setSubmitting] = useState(false);

  return (
    <div className="center">
      <div className="card">
        <h1>{copy.t("landing.title")}</h1>
        <p className="sub">{copy.t("landing.sub")}</p>

        {error && <div className="notice bad">{copy.ref(error)}</div>}

        {/* Shown to everyone and disabled for everyone who is not the admin, by owner decision:
            a guest should see what this app is rather than a page with a hole in it. The title
            is what turns a dead button into an explanation. The REAL gate is on the server, in
            handleCreate; this is the courtesy that stops people pressing it. */}
        <button
          className="primary"
          style={{ width: "100%" }}
          onClick={onCreate}
          disabled={!canCreate}
          title={canCreate ? undefined : copy.t("landing.adminOnly")}
        >
          {copy.t("landing.create")}
        </button>

        <div className="divider">{copy.t("landing.or")}</div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            // Normalize before sending. isLikelyCode accepts a code typed with lookalikes because
            // it folds them, but the wire schema does not have I, L, O, or U in its alphabet, so
            // the raw string would be refused as malformed by the server.
            if (ready) onJoin(normalizeCode(code));
          }}
        >
          <div className="field">
            <label htmlFor="code">{copy.t("landing.codeLabel")}</label>
            <input
              id="code"
              value={code}
              // No maxLength: it applies to pasted text too, so the browser would truncate a
              // pasted link to 12 characters before this handler ever saw it, which is exactly
              // how "http://localhost:5173/r/ABCD1234" used to land in the field as "HTTP://LOCAL".
              onChange={(event) => {
                const raw = event.target.value;
                setCode(codeFromShared(raw) ?? raw.toUpperCase().slice(0, MAX_TYPED));
              }}
              placeholder="ABCD1234"
              autoComplete="off"
              spellCheck={false}
              style={{ fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em" }}
            />
            {code !== "" && !ready && <p className="hint">{copy.t("landing.codeHint")}</p>}
          </div>
          <button type="submit" disabled={!ready} style={{ width: "100%" }}>
            {copy.t("landing.join")}
          </button>
        </form>

        {/* Last, and quiet. Exactly one person ever needs this control and everyone else has to
            look past it, so it sits under the thing they actually came to do. */}
        {adminRequired && (
        <div className="admin-strip">
          {isAdmin ? (
            <>
              <span className="admin-state">{copy.t("landing.adminLoggedIn")}</span>
              <button type="button" className="linklike" onClick={onLogout}>
                {copy.t("landing.adminLogout")}
              </button>
            </>
          ) : showLogin ? (
            <form
              className="admin-login"
              onSubmit={(event) => {
                event.preventDefault();
                if (submitting || password.length === 0) return;
                setSubmitting(true);
                setLoginError(null);
                void onLogin(password)
                  .then((ok) => {
                    // The password is dropped either way. Keeping it in state after a success
                    // leaves a credential sitting in a React tree for the life of the tab.
                    setPassword("");
                    if (ok) setShowLogin(false);
                    else setLoginError("wrong");
                  })
                  .catch(() => {
                    setPassword("");
                    setLoginError("unavailable");
                  })
                  .finally(() => setSubmitting(false));
              }}
            >
              <div className="field">
                <label htmlFor="admin-password">{copy.t("landing.adminPassword")}</label>
                <input
                  id="admin-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
              <button type="submit" disabled={submitting || password.length === 0}>
                {copy.t("landing.adminSubmit")}
              </button>
              {loginError && (
                <p className="hint bad">
                  {copy.t(loginError === "wrong" ? "landing.adminWrong" : "landing.adminUnavailable")}
                </p>
              )}
            </form>
          ) : (
            <button type="button" className="linklike" onClick={() => setShowLogin(true)}>
              {copy.t("landing.adminLogin")}
            </button>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
