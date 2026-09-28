// The schema, as an ordered list of migrations. Migration N is MIGRATIONS[N - 1].
//
// APPEND ONLY. A migration that has shipped is never edited or reordered: a database that already
// ran it records only its number, so an edit would change the schema of new installs and leave
// every existing one on the old shape with nothing to say they differ. A change to an existing
// table is a new migration at the end.
//
// Each entry runs inside its own transaction together with the row that records it, so a
// migration either lands completely and is recorded, or leaves no trace.

export const MIGRATIONS: readonly string[] = [
  // 1. A placeholder that proves the mechanism end to end before any real table needs it. Also a
  //    home for small single values about the database itself.
  `CREATE TABLE meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,

  // 2. Accounts (M3). Times are epoch milliseconds throughout, as INTEGER, so every comparison
  //    against "now" is arithmetic rather than date parsing.
  //    - id is opaque and random, never derived from the email, so it can travel (ledger rows,
  //      logs) without identifying anyone once the row is gone.
  //    - email is stored lowercased by the code that writes it, which is what makes UNIQUE mean
  //      "one account per address" rather than "one per spelling of it".
  //    - is_owner is re synced from OWNER_EMAIL on every boot, so it follows the setting rather
  //      than whatever it said when the row was written.
  `CREATE TABLE users (
     id            TEXT PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     display_name  TEXT NOT NULL,
     is_owner      INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
     created_at    INTEGER NOT NULL
   ) STRICT`,

  // 3. Refresh tokens, stored as sha256 hashes: a copy of this table is not a copy of anyone's
  //    session. family_id ties every rotation of one sign in together, so presenting a token that
  //    was already rotated away can revoke the whole chain (reuse detection).
  `CREATE TABLE refresh_tokens (
     id         TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     family_id  TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at    INTEGER,
     revoked_at INTEGER
   ) STRICT;
   CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
   CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id)`,

  // 4. Invites, stored as sha256 hashes of the normalized code, single use. created_by is null for
  //    an invite minted from the command line (npm run invite), which has no signed in user.
  `CREATE TABLE invites (
     code_hash  TEXT PRIMARY KEY,
     created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
     used_at    INTEGER
   ) STRICT`,

  // 5. Login lockout state, per account. Keyed by a keyed hash of the normalized EMAIL rather
  //    than by user id, so an address with no account locks exactly like one that has an account:
  //    a lockout that only real accounts could reach would answer "does this email exist" to
  //    anyone willing to fail ten times.
  `CREATE TABLE login_lockouts (
     email_hash      TEXT PRIMARY KEY,
     failures        INTEGER NOT NULL,
     last_failure_at INTEGER NOT NULL,
     locked_until    INTEGER
   ) STRICT`,
];
