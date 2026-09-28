// The signed in user's stored dialect (/api/me/preferences), kept in step with the picker.
//
// The pre join dialect picker IS the interface language control (state/store.ts, uiDialect), so
// one stored choice feeds both fields: the web client saves the same dialect as `dialect` and
// `uiDialect`. A native client is free to store them apart.
//
// Nothing is saved until the stored value has loaded. The store starts from the browser's own
// language, and saving that before the account's choice arrived would overwrite the choice with
// a guess, on every sign in, on every new device.

import { preferences, type Preferences } from "@translatv/shared";

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

const PATH = "/api/me/preferences";

export class PreferenceSync {
  /** The dialect the server holds, as far as this tab knows. Undefined until loaded. */
  private saved: string | null | undefined = undefined;

  constructor(private readonly fetch: Fetch) {}

  /** The stored preferences, or null when they could not be read. Saving is armed only once this succeeds. */
  async load(): Promise<Preferences | null> {
    try {
      const response = await this.fetch(PATH);
      if (!response.ok) return null;
      const parsed = preferences.safeParse(await response.json());
      if (!parsed.success) return null;
      this.saved = parsed.data.dialect;
      return parsed.data;
    } catch {
      return null;
    }
  }

  /** The picker moved. Saves it when it differs from what the server holds. Never throws. */
  async changed(dialect: string): Promise<void> {
    if (this.saved === undefined || this.saved === dialect) return;
    const previous = this.saved;
    this.saved = dialect;
    try {
      const response = await this.fetch(PATH, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dialect, uiDialect: dialect } satisfies Preferences),
      });
      if (!response.ok) this.saved = previous;
    } catch {
      // Unreachable. The choice still applies in this tab; the next change tries again.
      this.saved = previous;
    }
  }

  /** Signed out: forget, so the next account's value is loaded before anything is saved. */
  reset(): void {
    this.saved = undefined;
  }
}
