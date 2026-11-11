// The tiny static host the split end to end run serves the client from, and the example host
// configs in deploy/static/ it reads its headers from. The examples are what an operator copies,
// so they are checked here: the CSP is strict, names the API origin for both https and wss, and
// is the same in every example.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { headersFor, parseHeadersFile, retargetApiOrigin, startStaticServer } from "./static_server.mjs";

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "static");
const HEADERS = readFileSync(join(STATIC_DIR, "_headers.example"), "utf8");
const NGINX = readFileSync(join(STATIC_DIR, "nginx.conf.example"), "utf8");

function directives(csp) {
  return Object.fromEntries(
    csp
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values];
      }),
  );
}

describe("deploy/static examples", () => {
  const csp = headersFor(parseHeadersFile(HEADERS), "/")["Content-Security-Policy"];

  it("carry a CSP whose connect-src is self and the API origin, over https and wss only", () => {
    expect(csp).toBeTruthy();
    expect(directives(csp)["connect-src"]).toEqual(["'self'", "https://api.example.com", "wss://api.example.com"]);
  });

  it("keep scripts to self, with no inline script and no wildcard anywhere", () => {
    const d = directives(csp);
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
    expect(csp).not.toMatch(/(^|\s)(ws|wss|https?):(\s|;|$)/);
  });

  it("say the same CSP in the nginx example, every place it is set", () => {
    const set = [...NGINX.matchAll(/add_header Content-Security-Policy "([^"]+)"/g)].map((m) => m[1]);
    expect(set.length).toBeGreaterThan(0);
    for (const value of set) expect(value).toBe(csp);
  });

  it("send nosniff on every path, and cache hashed assets but never index.html", () => {
    const rules = parseHeadersFile(HEADERS);
    expect(headersFor(rules, "/r/ABCD")["X-Content-Type-Options"]).toBe("nosniff");
    expect(headersFor(rules, "/index.html")["Cache-Control"]).toBe("no-cache");
    expect(headersFor(rules, "/assets/index-abc.js")["Cache-Control"]).toContain("immutable");
  });

  it("can be pointed at another API origin, for the end to end run", () => {
    const moved = retargetApiOrigin(HEADERS, "http://127.0.0.1:9999");
    const d = directives(headersFor(parseHeadersFile(moved), "/")["Content-Security-Policy"]);
    expect(d["connect-src"]).toEqual(["'self'", "http://127.0.0.1:9999", "ws://127.0.0.1:9999"]);
  });
});

describe("startStaticServer", () => {
  let root;
  let server;
  let base;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "static-server-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
    server = await startStaticServer({ root, rules: parseHeadersFile(HEADERS), port: 0 });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  it("serves files as themselves, with a content type and the example's headers", async () => {
    const response = await fetch(`${base}/assets/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("content-security-policy")).toContain("connect-src");
  });

  it("answers a room link with index.html and a 200, the SPA fallback", async () => {
    const response = await fetch(`${base}/r/ABCD-1234`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>app</title>");
  });

  it("answers a missing asset with 404, never index.html", async () => {
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });

  it("never serves a file outside its root", async () => {
    const response = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    expect(await response.text()).not.toContain("root:");
  });

  it("has no /api of its own: a request there gets the fallback page, not JSON", async () => {
    // Which is exactly why the client must never call a relative /api path when it is split.
    const response = await fetch(`${base}/api/auth/login`);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
