// The store's public surface. Repositories (one module per table) arrive from M3 onward.

export { ephemeralDataRefusal, isEphemeralDataDir } from "./guard.js";
export { MIGRATIONS } from "./migrations.js";
export { openStore, type Store, type StoreOptions } from "./store.js";
