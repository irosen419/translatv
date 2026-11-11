// Blocking, reporting, recent calls and the owner's report list, over the account API.
//
// Every answer is parsed with the shared schema, the same one the server answers with, so a
// screen never renders a shape it did not expect. A refusal comes back as the server's code, and
// anything unreadable or unreachable as NETWORK, which the screens turn into "try again".
//
// Each SafetyApi acts as ONE account (safetyRegistry, through fetchAs), for the reason given in
// savedCorrections.ts: tabs share one sign in, and a list opened for one account must never act
// as another.

import {
  apiError,
  blocksResponse,
  callsPage,
  ownerReport,
  reportReceipt,
  reportsResponse,
  type BlocksResponse,
  type CallsPage,
  type OwnerReport,
  type ReportReason,
  type ReportReceipt,
  type ReportsResponse,
} from "@translatv/shared";

import { fetchAs, type AccountSession } from "./savedCorrections.js";
import type { AuthFailure } from "./session.js";

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

/** What this needs of a shared zod schema: its safeParse, typed by what it parses to. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export type SafetyResult<T> = { ok: true; value: T } | { ok: false; error: AuthFailure };

export interface ReportInput {
  contactId: string;
  reason: ReportReason;
  /** Sent only when there is something in it once trimmed. */
  details: string;
  alsoBlock: boolean;
}

/** How many recent calls the account page lists. */
export const RECENT_CALLS = 20;

export class SafetyApi {
  constructor(private readonly fetch: Fetch) {}

  private async request<T>(schema: Schema<T>, path: string, init?: RequestInit): Promise<SafetyResult<T>> {
    let response: Response;
    try {
      response = await this.fetch(path, init);
    } catch {
      return { ok: false, error: "NETWORK" };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const refused = apiError.safeParse(body);
      // NOT_FOUND and INTERNAL are the router's own codes, not the account API's; the screens say
      // "try again" for both, which is what NETWORK already means to them.
      if (refused.success && refused.data.error !== "NOT_FOUND" && refused.data.error !== "INTERNAL") {
        return { ok: false, error: refused.data.error };
      }
      return { ok: false, error: "NETWORK" };
    }
    const parsed = schema.safeParse(body);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: "NETWORK" };
  }

  private send<T>(schema: Schema<T>, method: string, path: string, body: unknown): Promise<SafetyResult<T>> {
    return this.request(schema, path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  calls(): Promise<SafetyResult<CallsPage>> {
    return this.request(callsPage, `/api/me/calls?limit=${RECENT_CALLS}`);
  }

  blocks(): Promise<SafetyResult<BlocksResponse>> {
    return this.request(blocksResponse, "/api/me/blocks");
  }

  block(contactId: string): Promise<SafetyResult<BlocksResponse>> {
    return this.send(blocksResponse, "POST", "/api/me/blocks", { contactId });
  }

  unblock(contactId: string): Promise<SafetyResult<BlocksResponse>> {
    return this.send(blocksResponse, "DELETE", "/api/me/blocks", { contactId });
  }

  report(input: ReportInput): Promise<SafetyResult<ReportReceipt>> {
    const details = input.details.trim();
    return this.send(reportReceipt, "POST", "/api/me/reports", {
      contactId: input.contactId,
      reason: input.reason,
      ...(details === "" ? {} : { details }),
      alsoBlock: input.alsoBlock,
    });
  }

  ownerReports(): Promise<SafetyResult<ReportsResponse>> {
    return this.request(reportsResponse, "/api/owner/reports");
  }

  review(id: string): Promise<SafetyResult<OwnerReport>> {
    return this.send(ownerReport, "POST", "/api/owner/reports/review", { id });
  }
}

/** One SafetyApi per account, each acting only as that account. */
export function safetyRegistry(session: AccountSession): (userId: string) => SafetyApi {
  const byAccount = new Map<string, SafetyApi>();
  return (userId) => {
    let api = byAccount.get(userId);
    if (!api) {
      api = new SafetyApi(
        fetchAs(userId, () => session.state().user?.id ?? null, (path, init) => session.authorizedFetch(path, init)),
      );
      byAccount.set(userId, api);
    }
    return api;
  };
}
