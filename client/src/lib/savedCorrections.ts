// A person's saved corrections: their stored glossary (/api/me/glossary), listed with a delete.
//
// The backstop the screen needs (owner decision C5, 2026-10-09). Corrections are saved after
// each call by rules alone, and rules cannot see a flipped meaning ("sí" saved as "no"), so the
// person can see every saved entry and delete the wrong ones.
//
// The API replaces the whole list on PUT. So a delete reads the list again first and writes back
// that list without the one entry, never the list on screen: a call that ended in another tab may
// have saved corrections since the screen loaded, and writing the old list would delete them.

import { glossaryDocument, type GlossaryEntry } from "@translatv/shared";

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

const PATH = "/api/me/glossary";

function same(a: GlossaryEntry, b: GlossaryEntry): boolean {
  return (
    a.source === b.source &&
    a.target === b.target &&
    a.sourceDialect === b.sourceDialect &&
    a.targetDialect === b.targetDialect
  );
}

/**
 * A fetch that only ever acts as `userId`.
 *
 * A delete is two requests, a read and then a write. Tabs share one sign in, and if another tab
 * moves this one to another account between them, the write would go out as the NEW account
 * carrying the OLD account's list, replacing everything the new one had saved. session's
 * authorizedFetch already refuses an account change DURING a request; this refuses one BETWEEN
 * them, by checking who is signed in before each request starts. The refusal is the same 409
 * ACCOUNT_MISMATCH authorizedFetch answers with, so callers see one kind of "no".
 */
export function fetchAs(userId: string, signedInAs: () => string | null, fetch: Fetch): Fetch {
  return (path, init) => {
    if (signedInAs() !== userId) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "ACCOUNT_MISMATCH" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return fetch(path, init);
  };
}

export class SavedCorrections {
  constructor(private readonly fetch: Fetch) {}

  /** The saved list, newest first, or null when it could not be read. Never throws. */
  async load(): Promise<GlossaryEntry[] | null> {
    try {
      const response = await this.fetch(PATH);
      if (!response.ok) return null;
      const parsed = glossaryDocument.safeParse(await response.json());
      return parsed.success ? parsed.data.entries : null;
    } catch {
      return null;
    }
  }

  /** Delete one entry. The list as it now stands, or null when the delete did not land. */
  async remove(entry: GlossaryEntry): Promise<GlossaryEntry[] | null> {
    const current = await this.load();
    if (current === null) return null;
    const kept = current.filter((e) => !same(e, entry));
    if (kept.length === current.length) return current;
    try {
      const response = await this.fetch(PATH, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: kept }),
      });
      if (!response.ok) return null;
      const parsed = glossaryDocument.safeParse(await response.json());
      return parsed.success ? parsed.data.entries : null;
    } catch {
      return null;
    }
  }
}

/** The slice of SessionManager the registry needs. */
export interface AccountSession {
  state(): { user: { id: string } | null };
  authorizedFetch(path: string, init?: RequestInit): Promise<Response>;
}

/**
 * One SavedCorrections per account, kept so the list's identity is stable across renders, and each
 * acting only as its own account (fetchAs). Here rather than in App.tsx so that pinning the
 * account is tested where it is wired: dropping fetchAs from this path went unnoticed by every
 * test in review round 1.
 */
export function savedCorrectionsRegistry(session: AccountSession): (userId: string) => SavedCorrections {
  const byAccount = new Map<string, SavedCorrections>();
  return (userId) => {
    let api = byAccount.get(userId);
    if (!api) {
      api = new SavedCorrections(
        fetchAs(userId, () => session.state().user?.id ?? null, (path, init) => session.authorizedFetch(path, init)),
      );
      byAccount.set(userId, api);
    }
    return api;
  };
}
