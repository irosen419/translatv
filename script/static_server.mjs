// A tiny static host for the built web client, standing in for Cloudflare Pages or nginx in the
// split end to end run (script/e2e_split.mjs). Not for production: it exists so the run proves the
// client works from an origin of its own, behind the very headers deploy/static/_headers.example
// tells an operator to use.
//
// What it does is what a real static host must do for this app, and no more: serve files as
// themselves, answer every other path (a room link, /r/<code>) with index.html and a 200, answer
// a missing asset with 404 rather than HTML, and add the headers file's headers by path.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Parse the `_headers` format (Cloudflare Pages, Netlify): a path pattern on its own line, then
 * indented `Name: value` lines. Comments start with #. Returns [{ pattern, headers }] in order.
 */
export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const line = raw.trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    current.headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return rules;
}

function matches(pattern, path) {
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

/** The headers for `path`: every matching rule, later rules winning, as the hosts apply them. */
export function headersFor(rules, path) {
  const out = {};
  for (const rule of rules) if (matches(rule.pattern, path)) Object.assign(out, rule.headers);
  return out;
}

/** The example's placeholder API hostname swapped for a real origin, https and wss together. */
export function retargetApiOrigin(text, origin) {
  const url = new URL(origin);
  const ws = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  return text.replaceAll("https://api.example.com", url.origin).replaceAll("wss://api.example.com", ws);
}

/** Serve `root` on `port` (0 for any), on 127.0.0.1. Resolves with the listening http.Server. */
export function startStaticServer({ root, rules, port = 0 }) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://static").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const send = (status, file, servedAs) => {
      res.writeHead(status, {
        ...headersFor(rules, servedAs),
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      });
      createReadStream(file).pipe(res);
    };

    const candidate = normalize(join(base, path));
    const inside = candidate === base || candidate.startsWith(base + sep);
    if (inside && existsSync(candidate) && statSync(candidate).isFile()) {
      send(200, candidate, path);
      return;
    }
    // A missing asset is a 404. Handing back index.html as JavaScript fails far from the cause.
    if (path.startsWith("/assets/")) {
      res.writeHead(404, headersFor(rules, path)).end();
      return;
    }
    // The SPA fallback: a room link and every other client route.
    send(200, join(base, "index.html"), "/index.html");
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolvePromise(server));
  });
}
