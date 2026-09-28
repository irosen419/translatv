// The store's public surface. Repositories are one module per table beside this file (users.ts,
// refreshTokens.ts, invites.ts, loginLockouts.ts, and from M5 preferences.ts, glossaries.ts and
// callHistory.ts), imported directly by the code that owns them.

export { ephemeralDataRefusal, isEphemeralDataDir } from "./guard.js";
export { MIGRATIONS } from "./migrations.js";
export { openStore, type Store, type StoreOptions } from "./store.js";
