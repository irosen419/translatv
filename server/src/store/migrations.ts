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
  //    home for small single values about the database itself. Accounts arrive in M3 as
  //    migration 2 onward.
  `CREATE TABLE meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,
];
