// The build refuses a bad VITE_API_ORIGIN, so a bundle that would send every request to the
// wrong place is never produced. The browser checks again at load (apiBase.ts), for a bundle built
// some other way; this is the earlier and louder of the two.

import type { Plugin, ResolvedConfig } from "vite";
import { describe, expect, it } from "vitest";

import viteConfig from "../../vite.config.js";

function apiOriginPlugin(): Plugin {
  const plugins = (viteConfig.plugins ?? []).flat() as Plugin[];
  const plugin = plugins.find((p) => p && typeof p === "object" && p.name === "translatv:api-origin");
  if (!plugin) throw new Error("the api origin plugin is not registered in vite.config.ts");
  return plugin;
}

function resolveWith(env: Record<string, string>): void {
  const hook = apiOriginPlugin().configResolved;
  const fn = typeof hook === "function" ? hook : hook?.handler;
  if (!fn) throw new Error("the api origin plugin has no configResolved hook");
  void fn.call({} as never, { env } as unknown as ResolvedConfig);
}

describe("vite.config.ts and VITE_API_ORIGIN", () => {
  it("builds with it unset, the one image deploy", () => {
    expect(() => resolveWith({})).not.toThrow();
  });

  it("builds with a proper origin", () => {
    expect(() => resolveWith({ VITE_API_ORIGIN: "https://api.example.com" })).not.toThrow();
  });

  it("stops the build on a value with a path, naming the variable", () => {
    expect(() => resolveWith({ VITE_API_ORIGIN: "https://api.example.com/v1" })).toThrow(/VITE_API_ORIGIN/);
  });
});
