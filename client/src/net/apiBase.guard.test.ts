// Guard: every request the client makes to the server goes through apiUrl().
//
// A web client built with VITE_API_ORIGIN is served by a static host, and a bare "/api/..." or
// "/healthz" literal resolves against THAT host. The static host answers with index.html (its SPA
// fallback) and a 200, so a forgotten call fails as a JSON parse error somewhere far from the
// cause, and only in the split deploy, never in the one image deploy or under npm run dev. A grep
// is the only check that sees it before a deploy does.
//
// The rule is stricter than "no fetch of a bare literal", on purpose: any string literal that
// names a server path must be the argument of apiUrl(...). A path held in a constant first
// (`const PATH = "/api/me/glossary"`) and fetched later is the same bug one step removed.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** The one module allowed to spell a server path without apiUrl (it defines apiUrl). */
const EXEMPT = new Set(["net/apiBase.ts"]);

/** A string literal that starts with a server path: /api, /api/..., or /healthz. */
const SERVER_PATH_LITERAL = /(["'`])\/(?:api(?:[/?]|\1)|healthz\b)/g;

/** Every literal naming a server path that is not wrapped in apiUrl(, as "file:line: text". */
export function unroutedServerPaths(file: string, source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SERVER_PATH_LITERAL)) {
    const index = match.index ?? 0;
    const before = source.slice(Math.max(0, index - "apiUrl(".length), index);
    if (before === "apiUrl(") continue;
    const line = source.slice(0, index).split("\n").length;
    const text = source.split("\n")[line - 1]?.trim() ?? "";
    found.push(`${file}:${line}: ${text}`);
  }
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [full];
  });
}

describe("every server path the client names goes through apiUrl", () => {
  it("catches the shapes the bug takes, so a pass below means something", () => {
    expect(unroutedServerPaths("x.ts", `fetch("/healthz")`)).toHaveLength(1);
    expect(unroutedServerPaths("x.ts", `fetch('/api/auth/login', init)`)).toHaveLength(1);
    expect(unroutedServerPaths("x.ts", "fetch(`/api/me/calls?limit=${n}`)")).toHaveLength(1);
    expect(unroutedServerPaths("x.ts", `this.deps.fetch("/api/account")`)).toHaveLength(1);
    expect(unroutedServerPaths("x.ts", `const PATH = "/api/me/glossary";`)).toHaveLength(1);
    expect(unroutedServerPaths("x.ts", `session.authorizedFetch("/api/invites")`)).toHaveLength(1);
    expect(unroutedServerPaths("x.ts", `fetch("/api")`)).toHaveLength(1);
  });

  it("lets the routed form, prose and unrelated paths through", () => {
    expect(unroutedServerPaths("x.ts", `fetch(apiUrl("/healthz"))`)).toEqual([]);
    expect(unroutedServerPaths("x.ts", `const PATH = apiUrl("/api/me/glossary");`)).toEqual([]);
    expect(unroutedServerPaths("x.ts", `// whether signup needs an invite, from /healthz.`)).toEqual([]);
    expect(unroutedServerPaths("x.ts", `navigate("/r/ABCD")`)).toEqual([]);
    expect(unroutedServerPaths("x.ts", `"/apiary"`)).toEqual([]);
  });

  it("holds for every client source file", () => {
    const offenders = sources(SRC).flatMap((file) => {
      const name = relative(SRC, file).split("\\").join("/");
      if (EXEMPT.has(name)) return [];
      return unroutedServerPaths(name, readFileSync(file, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("reaches the files it is guarding, so an empty scan cannot pass", () => {
    const names = sources(SRC).map((file) => relative(SRC, file).split("\\").join("/"));
    expect(names).toContain("App.tsx");
    expect(names).toContain("lib/session.ts");
    expect(names).toContain("lib/preferences.ts");
    expect(names).toContain("lib/savedCorrections.ts");
    expect(names).toContain("net/socket.ts");
  });
});
