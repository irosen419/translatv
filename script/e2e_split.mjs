#!/usr/bin/env node
// End to end, split: the web client as a static site on its OWN origin, the server API only on
// another (DEPLOY.md, "Two services: a static site and the API").
//
// e2e.mjs proves the app works when one server serves everything. This proves the other shape,
// with the parts that only exist in it switched on and strict:
//
//   - the client is built by `build:static` with VITE_API_ORIGIN pointing at the API's port, and
//     served by a tiny static host (static_server.mjs) with SPA fallback, behind the headers in
//     deploy/static/_headers.example, so the example CSP is the one being enforced;
//   - the server runs with NODE_ENV=production, so its development rule (any localhost origin)
//     is OFF and ORIGIN is the whole allowlist, set to the static origin alone, and SERVE_CLIENT=0;
//   - the static site and the API are different sites, not just different ports (127.0.0.1 and
//     localhost), so nothing passes by being same site.
//
// It fails if CORS is wrong (sign up, sign in and the /healthz signup mode all cross origins), if
// the socket's Origin check refuses the static origin (no room is ever created), if either check
// is too loose (a page on an unlisted origin must be refused both), or if the CSP blocks the API.
//
// Run with: node script/e2e_split.mjs (after `npm run build`; `npm run e2e` runs both).

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chromiumLaunchOptions, chromiumSource } from "./chromium.mjs";
import { accountsEnv, emailFor, PASSWORD, signUpViaApi } from "./accounts.mjs";
import { copyFor } from "./copy.mjs";
import { parseHeadersFile, retargetApiOrigin, startStaticServer } from "./static_server.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const en = copyFor("en-US");
const es = copyFor("es-AR");

let failures = 0;
let checks = 0;

function check(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function waitFor(fn, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${description}: ${JSON.stringify(last)?.slice(0, 200)}`);
}

/** A free port: the OS picks one, and it is released again for the caller to bind. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** As in e2e.mjs: its own process group, so stopping it stops tsx and node too. */
function startServer(env) {
  return spawn("npx", ["tsx", "server/src/index.ts"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
}
function stopServer(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function goneWithin(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await answers(url))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const root = mkdtempSync(join(tmpdir(), "e2e-split-"));
const API_PORT = await freePort();
const STATIC_PORT = await freePort();
const ROGUE_PORT = await freePort();
// Different hostnames as well as different ports: two SITES, not merely two origins.
const API = `http://localhost:${API_PORT}`;
const STATIC = `http://127.0.0.1:${STATIC_PORT}`;
/** The same build on an origin that is NOT in ORIGIN. Everything from here must be refused. */
const ROGUE = `http://127.0.0.1:${ROGUE_PORT}`;
const DIST = join(root, "static");

let server = null;
let staticServer = null;
let rogueServer = null;
let browser;

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopServer(server);
    rmSync(root, { recursive: true, force: true });
    process.exit(128 + constants.signals[signal]);
  });
}

const serverLog = [];
const pages = {};
const errors = [];
/** Pages whose console errors are expected: the rogue origin is SUPPOSED to be refused. */
const refusalsExpected = new Set();

console.log("Split deploy: a static site and an API on different origins.");
try {
  section("Building the client as a static site");
  const build = spawnSync(process.execPath, [join(repoRoot, "script", "build_static.mjs"), "--out", DIST], {
    cwd: repoRoot,
    env: { ...process.env, VITE_API_ORIGIN: API },
    encoding: "utf8",
  });
  check("build:static builds with VITE_API_ORIGIN set", build.status === 0, (build.stderr || "").slice(-300));
  check("and the secrets gate ran on that build and found nothing", /check:secrets clean/.test(build.stdout));
  const bundle = spawnSync("grep", ["-rl", API, join(DIST, "assets")], { encoding: "utf8" });
  check("the API origin is inlined into the bundle", bundle.status === 0);

  const headersText = retargetApiOrigin(readFileSync(join(repoRoot, "deploy", "static", "_headers.example"), "utf8"), API);
  const rules = parseHeadersFile(headersText);
  staticServer = await startStaticServer({ root: DIST, rules, port: STATIC_PORT });
  rogueServer = await startStaticServer({ root: DIST, rules, port: ROGUE_PORT });

  section("The API, alone");
  server = startServer({
    ...process.env,
    PORT: String(API_PORT),
    // Production, so the development origin rule (any localhost) is OFF: ORIGIN is all there is.
    NODE_ENV: "production",
    ORIGIN: STATIC,
    SERVE_CLIENT: "0",
    ANTHROPIC_API_KEY: "",
    // Production refuses a scratch data directory and an image layer ledger; this run is both.
    ALLOW_EPHEMERAL_DATA: "1",
    ALLOW_EPHEMERAL_LEDGER: "1",
    ...accountsEnv(root),
  });
  server.stdout.on("data", (d) => serverLog.push(String(d)));
  server.stderr.on("data", (d) => serverLog.push(String(d)));
  await waitFor(() => answers(`${API}/healthz`), "the API to answer /healthz", 30_000);

  const home = await fetch(`${API}/`);
  check(
    "with SERVE_CLIENT off, the API host serves no page: / is a JSON 404",
    home.status === 404 && (home.headers.get("content-type") ?? "").includes("application/json"),
    String(home.status),
  );
  check("and neither is a room link", (await fetch(`${API}/r/ABCD1234`)).status === 404);

  console.log(`\nChromium: ${chromiumSource()}`);
  browser = await chromium.launch(chromiumLaunchOptions());
  const contextA = await browser.newContext({ permissions: ["microphone", "camera"] });
  const contextB = await browser.newContext({ permissions: ["microphone", "camera"] });
  const ana = await contextA.newPage();
  const ben = await contextB.newPage();
  pages.ana = ana;
  pages.ben = ben;

  const socketUrls = [];
  for (const [name, page] of [["ana", ana], ["ben", ben]]) {
    page.on("websocket", (ws) => socketUrls.push(ws.url()));
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !refusalsExpected.has(name)) errors.push(`${name} console: ${m.text()}`);
    });
  }

  section("Signing up and in, from the static origin");
  await ana.goto(STATIC);
  await ana.getByRole("button", { name: en("auth.submit.signIn") }).waitFor();
  check("the static host serves the app", true);
  await ana.getByRole("button", { name: en("auth.switch.toSignUp") }).click();
  // The client starts from "invite" and moves only on /healthz's answer, so a missing invite field
  // on this open server means the cross origin /healthz was read.
  check(
    "the signup mode was read from the API's /healthz, across origins",
    await waitFor(async () => (await ana.getByLabel(en("auth.invite")).count()) === 0, "the invite field to go").catch(() => false),
  );
  await ana.getByLabel(en("auth.displayName"), { exact: true }).fill("Ana");
  await ana.getByLabel(en("auth.email")).fill(emailFor("Ana"));
  await ana.getByLabel(en("auth.password"), { exact: true }).fill(PASSWORD);
  await ana.getByRole("button", { name: en("auth.submit.signUp") }).click();
  check(
    "signing up through the screen works across origins",
    await ana
      .getByRole("button", { name: "Start a new chat" })
      .waitFor()
      .then(() => true)
      .catch(() => false),
  );
  check(
    "the refresh token is kept on the static origin, where the client reads it",
    typeof (await ana.evaluate(() => localStorage.getItem("translatv.refresh"))) === "string",
  );

  await signUpViaApi(API, "Ben");
  await ben.goto(STATIC);
  await ben.getByLabel(en("auth.email")).fill(emailFor("Ben"));
  await ben.getByLabel(en("auth.password"), { exact: true }).fill(PASSWORD);
  await ben.getByRole("button", { name: en("auth.submit.signIn") }).click();
  check(
    "signing in through the screen works across origins",
    await ben
      .getByRole("button", { name: "Start a new chat" })
      .waitFor()
      .then(() => true)
      .catch(() => false),
  );

  section("A call, with the socket on the API origin");
  await ana.getByRole("button", { name: "Start a new chat" }).click();
  await ana.getByLabel("Your name, just for this chat").fill("Ana");
  await ana.getByLabel("Your language and region").selectOption("en-US");
  await ana.getByRole("button", { name: /Create and allow microphone/ }).click();
  const code = await waitFor(
    async () => {
      const text = await ana.locator(".code-badge").textContent().catch(() => null);
      return text && text.trim().length === 8 ? text.trim() : null;
    },
    "a room code",
  );
  check("a room is created over a socket from the static origin", /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code), code);

  // The link a person would share: the STATIC origin's /r/<code>, opened as a first navigation,
  // which only works because the static host falls back to index.html.
  await ben.goto(`${STATIC}/r/${code}`);
  await ben.getByLabel("Your name, just for this chat").fill("Ben");
  await ben.getByLabel("Your language and region").selectOption("es-AR");
  await ben.getByRole("button", { name: es("prejoin.submit.join") }).click();
  check(
    "the second browser joins by the room link",
    await waitFor(async () => ben.locator(".room").isVisible(), "Ben to enter the room").catch(() => false),
  );

  await ana.getByPlaceholder("Type a message").fill("see you at the station");
  await ana.getByPlaceholder("Type a message").press("Enter");
  check(
    "a caption line crosses from one browser to the other",
    await waitFor(
      async () => ((await ben.locator(".transcript").textContent()) ?? "").includes("see you at the station"),
      "Ben to receive the line",
    ).catch(() => false),
  );

  const expectedSocket = `ws://localhost:${API_PORT}/ws`;
  check(
    "every socket went to the API origin, none to the static host",
    socketUrls.length > 0 && socketUrls.every((url) => url === expectedSocket),
    socketUrls.join(" "),
  );
  check(
    "and no socket URL carries a token",
    socketUrls.every((url) => !/bearer|token|access/i.test(url)),
  );

  section("Signing out");
  await ana.locator(".gear-button").click();
  const leave = ana.getByRole("button", { name: en("room.leave") });
  if (await leave.isVisible().catch(() => false)) await leave.click();
  // The host leaving ends the chat; the start page, where signing out lives, is one press away.
  const back = ana.getByRole("button", { name: en("app.ended.back") });
  await back.waitFor({ timeout: 15_000 });
  await back.click();
  const signOut = ana.getByRole("button", { name: en("account.signOut") });
  await signOut.waitFor({ timeout: 15_000 });
  await signOut.click();
  check(
    "signing out across origins goes back to the sign in screen",
    await ana
      .getByRole("button", { name: en("auth.submit.signIn") })
      .waitFor()
      .then(() => true)
      .catch(() => false),
  );
  check(
    "and forgets the refresh token",
    (await ana.evaluate(() => localStorage.getItem("translatv.refresh"))) === null,
  );

  section("An origin that is not in ORIGIN is refused at both doors");
  const contextR = await browser.newContext({ permissions: ["microphone", "camera"] });
  const rogue = await contextR.newPage();
  pages.rogue = rogue;
  refusalsExpected.add("rogue");
  rogue.on("pageerror", (e) => errors.push(`rogue: ${e.message}`));
  await rogue.goto(ROGUE);
  const session = await (
    await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: emailFor("Ben"), password: PASSWORD }),
    })
  ).json();
  const rogueFetch = await rogue.evaluate(async (api) => {
    try {
      await fetch(`${api}/healthz`);
      return "read";
    } catch {
      return "blocked";
    }
  }, API);
  check("its page cannot read the API (no CORS headers for it)", rogueFetch === "blocked", rogueFetch);
  const rogueSocket = await rogue.evaluate(
    ({ url, token }) =>
      new Promise((resolve) => {
        const socket = new WebSocket(url, ["translatv.v1", `bearer.${token}`]);
        socket.onopen = () => {
          socket.close();
          resolve("open");
        };
        socket.onclose = () => resolve("refused");
        setTimeout(() => resolve("timeout"), 10_000);
      }),
    { url: expectedSocket, token: session.accessToken },
  );
  check("its socket is refused even with a valid token", rogueSocket === "refused", rogueSocket);
  check(
    "and the server says why",
    serverLog.join("").includes("ws.origin_refused"),
  );

  section("Page health");
  check("no uncaught page errors or console errors on the allowed origin", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
  checks += 1;
  failures += 1;
  console.error(`\nFATAL: ${error.message}`);
  for (const [name, page] of Object.entries(pages)) {
    if (!page || page.isClosed()) continue;
    try {
      const text = (await page.locator("body").innerText()).replace(/\n{2,}/g, "\n").slice(0, 700);
      console.error(`\n--- ${name} was showing ---\n${text}`);
    } catch {
      console.error(`\n--- ${name}: could not read the page ---`);
    }
  }
  if (errors.length > 0) console.error(`\n--- page errors ---\n${errors.join("\n")}`);
  console.error(`\n--- server tail ---\n${serverLog.slice(-15).join("")}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => (staticServer ? staticServer.close(resolve) : resolve()));
  await new Promise((resolve) => (rogueServer ? rogueServer.close(resolve) : resolve()));
  if (server) {
    section("Shutdown");
    stopServer(server);
    check("the API is gone once stopped, so a run leaves nothing running", await goneWithin(`${API}/healthz`, 5000));
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${checks - failures} of ${checks} split checks passed.`);
process.exit(failures === 0 ? 0 : 1);
