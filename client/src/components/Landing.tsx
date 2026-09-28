import { useState } from "react";
import type { PublicUser } from "@translatv/shared";
import { codeFromShared, isLikelyCode, normalizeCode } from "../lib/code.js";
import { useCopy } from "../i18n/useCopy.js";
import type { CopyRef } from "../i18n/copy.js";
import type { AuthOutcome } from "../lib/session.js";
import { DeleteAccount } from "./DeleteAccount.jsx";

/** Longest thing worth keeping as a typed code, once it is clear it is not a link. */
const MAX_TYPED = 12;

interface Props {
  initialCode: string | null;
  /** Why the last attempt failed, so someone sent back here knows what happened. */
  error: CopyRef | null;
  /**
   * Who is signed in, or null while a stored session is still being restored. The page renders
   * either way: a reload mid call lands here, and it must show the room code field at once rather
   * than a blank card while one refresh request is in flight.
   */
  user: PublicUser | null;
  onCreate(): void;
  onJoin(code: string): void;
  onSignOut(): void;
  /** Owner only. Resolves the new code, or null when it could not be made. */
  onCreateInvite(): Promise<string | null>;
  /** Delete the account `userId` (the one shown) after the password is typed again. */
  onDeleteAccount(password: string, userId: string): Promise<AuthOutcome>;
}

export function Landing({
  initialCode,
  error,
  user,
  onCreate,
  onJoin,
  onSignOut,
  onCreateInvite,
  onDeleteAccount,
}: Props) {
  const [code, setCode] = useState(initialCode ?? "");
  const ready = isLikelyCode(code);
  const copy = useCopy();
  const [invite, setInvite] = useState<{ code: string } | { failed: true } | null>(null);
  const [minting, setMinting] = useState(false);

  return (
    <div className="center">
      <div className="card">
        <h1>{copy.t("landing.title")}</h1>
        <p className="sub">{copy.t("landing.sub")}</p>

        {error && <div className="notice bad">{copy.ref(error)}</div>}

        {/* Any signed in account may start a call. The server is the gate (it refuses an
            unauthenticated socket outright); this page is only ever shown to someone signed in. */}
        <button className="primary" style={{ width: "100%" }} onClick={onCreate}>
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

        {/* Last, and quiet: who you are, and the way out. The invite control is the owner's
            alone, and the server checks that rather than trusting this button's absence. */}
        <div className="account-strip">
          {user && (
            <span className="account-state">{copy.t("account.signedInAs", { name: user.displayName })}</span>
          )}
          <button type="button" className="linklike" onClick={onSignOut}>
            {copy.t("account.signOut")}
          </button>
          {user?.isOwner && (
            <button
              type="button"
              className="linklike"
              disabled={minting}
              onClick={() => {
                setMinting(true);
                void onCreateInvite()
                  .then((minted) => setInvite(minted ? { code: minted } : { failed: true }))
                  .catch(() => setInvite({ failed: true }))
                  .finally(() => setMinting(false));
              }}
            >
              {copy.t("account.invite.create")}
            </button>
          )}
          {invite && "code" in invite && (
            <div className="invite-result">
              <p className="hint">{copy.t("account.invite.lead")}</p>
              <code className="owner-invite-code">{invite.code}</code>
            </div>
          )}
          {invite && "failed" in invite && <p className="hint bad">{copy.t("account.invite.failed")}</p>}
          {/* Keyed by the account, so a form opened for one account never outlives it. Tabs share
              one sign in, and when another tab moves this one to another account, the form, its
              typed password and any refusal go with the old account. The deletion names the
              account the form was opened for, which the server checks against the bearer. */}
          {user && <DeleteAccount key={user.id} onDelete={(password) => onDeleteAccount(password, user.id)} />}
        </div>
      </div>
    </div>
  );
}
