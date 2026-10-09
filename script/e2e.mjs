#!/usr/bin/env node
// End to end verification: two real browsers, one real server, one real call.
//
// This is the test that proves the app actually works rather than that its parts do. It drives
// two Chromium contexts with fake media through the whole flow: create, share the code, join,
// negotiate WebRTC, exchange messages through the translation pipeline, correct a translation,
// leave, and end.
//
// Why text chat rather than speech: the fake media device emits a synthetic tone, not speech,
// so recognition cannot produce a real transcript here. Text chat goes through the IDENTICAL
// server path (same handler, same transcript, same translation, same broadcast), so exercising
// it verifies everything except the browser's speech engine itself, which needs a real
// microphone and a human voice. That gap is what script/spike.html exists for.
//
// Accounts (M4): every call needs a signed in account. The server runs with SIGNUP_MODE=open so
// this harness can make its own. Ana and Ben sign up through the real sign up screen (and Ben
// signs out and back in through the sign in screen), because those screens are part of what is
// being verified. Everyone after them gets an account through the API and starts signed in, with
// the refresh token placed in their browser's storage exactly where the client keeps it, because
// clicking through the same form six more times would test nothing new.
//
// Run with: node script/e2e.mjs

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { chromiumLaunchOptions, chromiumSource } from "./chromium.mjs";
import { accountsEnv, emailFor, PASSWORD, signedInContext as signedInContextFor } from "./accounts.mjs";
import { copyFor } from "./copy.mjs";

/**
 * The words each simulated person reads.
 *
 * Ben picks Argentine Spanish at the prejoin screen, and from that click the entire interface he
 * is looking at is in Spanish: his composer says Escribí un mensaje, his drawer says Salir del
 * chat. Driving him with English selectors after that point is driving a page that does not
 * exist. Looking the labels up keeps this harness honest about which person is reading what,
 * which is the feature it is here to exercise.
 */
const en = copyFor("en-US");
const es = copyFor("es-AR");

/**
 * The translation toggle names its own STATE, not the action pressing it performs. So the
 * button to press to turn translation OFF is the one that currently reads "Translation is on".
 * These two read backwards from the old action labels on purpose.
 *
 * Built from the copy files rather than written out in English, because the previous hardcoded
 * literals did not move when the copy did and the only thing that noticed was CI.
 */
const translationButton = (state) =>
  `${en("room.translation.lead")} ${en(`room.translation.${state}`)}`;

let PORT = 0;
let BASE = "";

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

/**
 * Open the settings drawer.
 *
 * Leaving and ending a chat live in there now rather than in a footer, so anything reaching for
 * them has to open it first. The drawer is inert while shut, so a click without this does not
 * silently hit the wrong thing, it fails.
 */
async function openSettings(page) {
  // Found by class rather than by its label. The label is now in whichever language that page's
  // dialect picker is set to, so /settings/i matched Ana and silently stopped matching Ben the
  // moment he picked Spanish. The gear is one element with one class in both.
  //
  // Idempotent on purpose. The gear TOGGLES, so a second unconditional click would shut the
  // drawer again and the failure would look like the control vanishing rather than like a test
  // opening it twice.
  const gear = page.locator(".gear-button");
  if ((await gear.getAttribute("aria-expanded")) === "true") return;
  await gear.click();
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

/** A context that starts signed in as a fresh account, made through the API. */
function signedInContext(name, options = {}) {
  return signedInContextFor(browser, BASE, name, options);
}

/** Sign up through the real screen, as a person would. */
async function signUpViaScreen(page, name) {
  await page.goto(BASE);
  await page.getByRole("button", { name: en("auth.switch.toSignUp") }).click();
  await page.getByLabel(en("auth.displayName"), { exact: true }).fill(name);
  await page.getByLabel(en("auth.email")).fill(emailFor(name));
  await page.getByLabel(en("auth.password")).fill(PASSWORD);
  await page.getByRole("button", { name: en("auth.submit.signUp") }).click();
  await page.getByRole("button", { name: "Start a new chat" }).waitFor();
}

/** Open the sign up form, as a person arriving at the app would. */
async function openSignUp(page, base) {
  await page.goto(base);
  await page.getByRole("button", { name: en("auth.switch.toSignUp") }).click();
}

/** Fill in the sign up form on an invite only server and submit it. The outcome is the caller's. */
async function submitSignUp(page, name, invite) {
  await page.getByLabel(en("auth.displayName"), { exact: true }).fill(name);
  await page.getByLabel(en("auth.email")).fill(emailFor(name));
  await page.getByLabel(en("auth.password")).fill(PASSWORD);
  await page.getByLabel(en("auth.invite")).fill(invite);
  await page.getByRole("button", { name: en("auth.submit.signUp") }).click();
}

/**
 * A session for `name` (its access token and user), from a sign in of its own. A new token family,
 * so no page's session moves: refreshing the token a page holds from here would rotate it out from
 * under that page.
 */
async function apiSignIn(base, name) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: emailFor(name), password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`sign in for ${name} answered ${response.status}`);
  return response.json();
}

/** Delete `session`'s account through the API, as another device would. Resolves the status. */
async function apiDeleteAccount(base, session) {
  const response = await fetch(`${base}/api/account`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({ password: PASSWORD, userId: session.user.id }),
  });
  return response.status;
}

/**
 * Make an account called `name` on an invite only server, with an invite `owner` mints through the
 * API. Resolves the sign up's answer: its tokens and user.
 */
async function apiInviteSignUp(base, owner, name) {
  const invite = await fetch(`${base}/api/invites`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.accessToken}` },
  }).then((response) => response.json());
  const response = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: emailFor(name), password: PASSWORD, displayName: name, invite: invite.code }),
  });
  if (response.status !== 201) throw new Error(`signup for ${name} answered ${response.status}`);
  return response.json();
}

/** A context that starts signed in with `refreshToken`, kept where the client keeps it. */
function contextSignedInWith(base, refreshToken, options = {}) {
  return browser.newContext({
    ...options,
    storageState: {
      cookies: [],
      origins: [{ origin: base, localStorage: [{ name: "translatv.refresh", value: refreshToken }] }],
    },
  });
}

/** A local port nothing listens on: the OS picks a free one, and it is released again. */
async function closedPort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Installed before a page loads: an outage the test switches on, for the page's sockets alone.
 * Every socket the page opens is kept, so the test can drop them. While `__offline` is set, a new
 * one goes to `deadUrl`, where nothing listens, so it never opens: from inside the app that is an
 * outage, and also how a refused token looks. `__failedWhileOffline` counts those.
 */
function socketOutageSwitch(deadUrl) {
  const Real = window.WebSocket;
  window.__sockets = [];
  window.__protocols = [];
  window.__offline = false;
  window.__failedWhileOffline = 0;
  window.WebSocket = class extends Real {
    constructor(url, protocols) {
      const offline = window.__offline;
      super(offline ? deadUrl : url, protocols);
      if (offline) this.addEventListener("close", () => (window.__failedWhileOffline += 1));
      window.__sockets.push(this);
      window.__protocols.push([protocols ?? []].flat());
    }
  };
}

/**
 * The account a socket's subprotocols speak for, or null: the bearer is `<payload>.<signature>`,
 * and the payload is base64url JSON naming the user (server/src/auth/accessTokens.ts).
 */
function accountOfSocket(protocols) {
  const bearer = protocols.find((protocol) => protocol.startsWith("bearer."));
  if (!bearer) return null;
  try {
    const payload = bearer.slice("bearer.".length).split(".")[0];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).sub ?? null;
  } catch {
    return null;
  }
}

/**
 * A notice a screen reader is told about. Each of these arrives with the screen that shows it,
 * text and all, and a region inserted already holding its text is announced reliably only as an
 * alert: a polite status announces changes to a region that was already there (reasoned from ARIA
 * and how screen readers treat live regions; no screen reader was run). So only an alert counts
 * here. Accepting a status as well let a notice inserted as one pass (measured in review), and that
 * one is likely silent. A polite region kept mounted, with its text changed in place, would be
 * announced, and would need this taught to recognize that region.
 */
const announced = (page, text) => page.locator('[role="alert"]').filter({ hasText: text });

/**
 * Start `npx tsx server/src/index.ts` as a process group of its own, and stop it as one. npx does
 * not forward SIGTERM to the tsx it starts, nor tsx to its node, so killing only the npx left the
 * server running after every run (one leaked per run, measured), still holding its port and data.
 */
function startServer(env) {
  return spawn("npx", ["tsx", "server/src/index.ts"], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
}
function stopServer(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/** Whether the server at base answers its health check right now. */
async function answers(base) {
  try {
    return (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

/**
 * Whether the server at base stops answering within ms. Dropping `detached` above, or signalling
 * only the npx, left both servers running after every run with every check green (measured in
 * review), so a stop is checked rather than assumed.
 */
async function goneWithin(base, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await answers(base))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Installed before a page loads: records whether the sign in form was EVER inserted. It reads the
 * mutation records rather than the live document, because React can mount the form and swap it
 * out within one task, before any observer callback sees the DOM. Keyed on the email field, which
 * only the sign in form has (the delete account form shares its heading class).
 */
function watchForSignInForm() {
  window.__sawSignInForm = false;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches("#auth-email") || node.querySelector("#auth-email")) window.__sawSignInForm = true;
      }
    }
  }).observe(document, { childList: true, subtree: true });
}

/** Resolves true once the locator shows up, false if it never does. */
const reached = (locator) =>
  locator
    .waitFor()
    .then(() => true)
    .catch(() => false);

// A ledger root the server can write to without touching the repo's real one.
const root = mkdtempSync(join(tmpdir(), "e2e-"));
mkdirSync(join(root, "out", "translatv"), { recursive: true });
writeFileSync(join(root, "out", "translatv", "spend_log.jsonl"), "", "utf8");

console.log("Starting server...");
const server = startServer({
    ...process.env,
    // 0 means "any free port". The real one comes back on the listening log line.
    PORT: "0",
    // No ORIGIN needed: in development the server accepts any localhost origin regardless of
    // port, which is what lets this harness use an OS assigned one.
    NODE_ENV: "development",
    // Deliberately NO ANTHROPIC_API_KEY. This run verifies the degraded mode end to end:
    // the call, the transcript, and the original text must all work with translation off.
    ANTHROPIC_API_KEY: "",
    // Open signup and a throwaway database: see script/accounts.mjs.
    ...accountsEnv(root),
});
const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));

let browser;
/** The second server, for the invite only section. Killed in finally if a step before it throws. */
let inviteServer = null;

// The servers are detached (their own process groups), so a signal sent to this run's group, as
// a terminal's Ctrl-C or a closed terminal sends, no longer reaches them, and Node exits on these
// signals without running the finally below. So they are stopped here too, the scratch root is
// removed, and the run exits as a shell expects, 128 plus the signal's number. A SIGKILL cannot
// be caught: after one, both servers are still running, and the scratch root and the browser's
// profile directory stay on disk.
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopServer(inviteServer);
    stopServer(server);
    rmSync(root, { recursive: true, force: true });
    process.exit(128 + constants.signals[signal]);
  });
}

const pages = {};
/** Set to a page's name for the one step that expects the server to answer 401. */
let expectRefusal = null;
const errors = [];
try {
  PORT = await waitFor(
    async () => {
      const match = serverLog.join("").match(/"event":"listening","port":(\d+)/);
      return match ? Number(match[1]) : null;
    },
    "the server to report its port",
  );
  BASE = `http://localhost:${PORT}`;
  await waitFor(
    async () => (await fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false)),
    "the server to answer /healthz",
  );
  console.log(`Server is up on ${PORT}.\n`);

  console.log(`Chromium: ${chromiumSource()}`);
  browser = await chromium.launch(chromiumLaunchOptions());

  const contextA = await browser.newContext({ permissions: ["microphone", "camera"] });
  const contextB = await browser.newContext({ permissions: ["microphone", "camera"] });
  const ana = await contextA.newPage();
  const ben = await contextB.newPage();

  // Every socket URL any page opens, to prove the access token never rides in one.
  const socketUrls = [];
  for (const page of [ana, ben]) page.on("websocket", (ws) => socketUrls.push(ws.url()));

  pages.ana = ana;
  pages.ben = ben;
  for (const [name, page] of [["ana", ana], ["ben", ben]]) {
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      // The browser logs every non 2xx response as a console error. The one 401 this run asks
      // for on purpose (a wrong password, below) is not a page fault, and is the only one let by.
      if (expectRefusal === name && /status of 401/.test(m.text())) return;
      errors.push(`${name} console: ${m.text()}`);
    });
    // A renderer death surfaces as "Target crashed" on whichever call happened to be in flight,
    // which names the wrong thing and cost a long investigation once already. Say plainly that
    // the process died, and name the one cause seen so far so the next person starts there.
    page.on("crash", () => {
      errors.push(
        `${name}: the renderer process CRASHED. This is not a JavaScript error and no try/catch ` +
          `can catch it. Check which browser launched above: chrome-headless-shell is a stripped ` +
          `build and crashes on SpeechRecognition.available(), which the prejoin screen calls.`,
      );
    });
  }

  // ---------------------------------------------------------------------
  section("Accounts");
  await ana.goto(BASE);
  check(
    "someone with no account is asked to sign in before anything else",
    await ana.getByRole("button", { name: en("auth.submit.signIn") }).isVisible(),
  );
  check(
    "an open server does not ask for an invite code",
    (await ana.getByLabel(en("auth.invite")).count()) === 0,
  );
  await signUpViaScreen(ana, "Ana");
  check(
    "signing up lands on the start page, signed in",
    (await ana.locator(".account-strip").innerText()).includes(en("account.signedInAs").replace("{name}", "Ana")),
  );

  await signUpViaScreen(ben, "Ben");
  await ben.getByRole("button", { name: en("account.signOut") }).click();
  check(
    "signing out goes back to the sign in screen",
    await ben
      .getByRole("button", { name: en("auth.submit.signIn") })
      .waitFor()
      .then(() => true)
      .catch(() => false),
  );
  check(
    "and forgets the refresh token",
    (await ben.evaluate(() => localStorage.getItem("translatv.refresh"))) === null,
  );
  await ben.getByLabel(en("auth.email")).fill(emailFor("Ben"));
  await ben.getByLabel(en("auth.password")).fill("not the password");
  expectRefusal = "ben";
  await ben.getByRole("button", { name: en("auth.submit.signIn") }).click();
  check(
    "a wrong password is refused with a sentence, not a crash",
    await ben
      .getByText(en("auth.error.INVALID_CREDENTIALS"))
      .waitFor()
      .then(() => true)
      .catch(() => false),
  );
  await ben.getByLabel(en("auth.password")).fill(PASSWORD);
  await ben.getByRole("button", { name: en("auth.submit.signIn") }).click();
  await ben.getByRole("button", { name: "Start a new chat" }).waitFor();
  expectRefusal = null;
  check("signing back in with the right password works", true);

  // ---------------------------------------------------------------------
  section("Creating a room");
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
  check("a room code is issued", /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code), code);
  check("the creator lands in the room", await ana.locator(".room").isVisible());

  // ---------------------------------------------------------------------
  section("Joining with the code");

  // Pasting a shared link into the code field has to work, because that is what people actually
  // have on the clipboard after clicking "Copy chat link". This used to leave "HTTP://LOCAL" in
  // the box and a permanently disabled button: the field's maxLength truncated the paste before
  // any handler could read it. Checked before the ordinary path because filling with the bare
  // code afterwards proves nothing about the paste.
  await ben.getByLabel("Room code").fill(`${BASE}/r/${code}`);
  check(
    "a pasted room link collapses to the bare code",
    (await ben.getByLabel("Room code").inputValue()) === code,
    await ben.getByLabel("Room code").inputValue(),
  );
  check(
    "the join button is enabled after pasting a link",
    await ben.getByRole("button", { name: "Join chat" }).isEnabled(),
  );

  // Deliberately joined with a code the form has to normalize before sending. isLikelyCode folds
  // separators and lookalikes, so the button enables, but the wire schema rejects anything outside
  // its alphabet, and the form used to send exactly what was typed. A hyphen exercises that path
  // for any code, where an O for zero substitution would only work when the code contains a zero.
  await ben.getByLabel("Room code").fill(`${code.slice(0, 4)}-${code.slice(4)}`);
  check(
    "a code typed with a separator still enables the button",
    await ben.getByRole("button", { name: "Join chat" }).isEnabled(),
  );
  await ben.getByRole("button", { name: "Join chat" }).click();
  await ben.getByLabel("Your name, just for this chat").fill("Ben");
  // "Load corrections from a past chat" read the transcript download, and both are gone: saved
  // corrections come from the account now (owner decisions of 2026-09-28 and 2026-10-09).
  check(
    "the pre join screen offers no file to load corrections from",
    (await ben.locator('input[type="file"]').count()) === 0,
  );
  await ben.getByLabel("Your language and region").selectOption("es-AR");
  // Everything Ben sees is Spanish from here. The button he is about to press already says so.
  check(
    "picking a dialect switches the interface into that language",
    await ben.getByRole("button", { name: es("prejoin.submit.join") }).isVisible(),
  );
  await ben.getByRole("button", { name: es("prejoin.submit.join") }).click();

  await waitFor(async () => ben.locator(".room").isVisible(), "Ben to enter the room");
  check("the joiner lands in the room", true);
  check(
    "the room itself is in the language he picked",
    (await ben.locator("body").innerText()).includes(es("room.leave")) ||
      (await ben.locator("#control-drawer").innerText()).includes(es("room.leave")) ||
      (await ben.getByPlaceholder(es("composer.placeholder")).count()) > 0,
  );

  check(
    "each sees the other's name",
    (await ana.locator(".names").textContent()).includes("Ben") &&
      (await ben.locator(".names").textContent()).includes("Ana"),
  );

  // ---------------------------------------------------------------------
  section("WebRTC negotiation");
  // The selector here is load bearing. ".video-area video" ALSO matches the self view, which is
  // nested inside the same container, so it was satisfied by a page showing its own camera and
  // nothing from the peer. That is exactly the state this check existed to catch, and it passed
  // through it for the entire life of the project. The remote video is a DIRECT child.
  //
  // And srcObject being set is not enough either: it is assigned from a stream that may hold
  // only audio. The assertion is a live video track actually arriving from the other side.
  const remoteVideoLive = () => {
    const video = document.querySelector(".video-area > video");
    if (!video || !video.srcObject) return false;
    const tracks = video.srcObject.getVideoTracks();
    return tracks.length > 0 && tracks[0].readyState === "live";
  };

  const connected = await waitFor(
    async () => {
      const state = await ana.evaluate(() => document.querySelector(".chip.bad") === null);
      const benSeesAna = await ben.evaluate(remoteVideoLive);
      const anaSeesBen = await ana.evaluate(remoteVideoLive);
      return state && benSeesAna && anaSeesBen ? true : null;
    },
    "the peer connection to carry media",
    20_000,
  ).catch(() => false);
  check("media flows between the two peers, in BOTH directions", connected === true);

  // ---------------------------------------------------------------------
  section("The transcript pipeline");
  await ana.getByPlaceholder("Type a message").fill("do you have time tomorrow");
  await ana.getByPlaceholder("Type a message").press("Enter");

  const benSeesIt = await waitFor(
    async () => {
      const text = await ben.locator(".transcript").textContent();
      return text.includes("do you have time tomorrow") ? text : null;
    },
    "Ben to receive the line",
  );
  check("a message reaches the other person", Boolean(benSeesIt));

  // Waited for rather than read straight away, because Ana and Ben are separate browsers being
  // told the same thing by the same broadcast, and nothing orders one delivery before the other.
  // Reading Ana the instant Ben was ready passed on a fast machine and failed on CI, which is a
  // flake, not a finding: there is no optimistic local insert, so the sender's own line arrives
  // by the same transcript.final everyone else gets. Still a real assertion, since a line that
  // never arrives times out and fails rather than being waited away.
  const anaSeesItToo = await waitFor(
    async () => {
      const text = await ana.locator(".transcript").textContent();
      return text.includes("do you have time tomorrow") ? text : null;
    },
    "Ana to see her own line",
  ).catch(() => false);
  check("the sender sees their own line too", Boolean(anaSeesItToo));

  // With no API key, translation must degrade rather than break: the original text stays
  // visible and the line is marked, never blank and never a permanent spinner.
  const degraded = await waitFor(
    async () => {
      const text = await ben.locator(".transcript").textContent();
      return !text.includes("translating...") ? text : null;
    },
    "the pending state to resolve",
  );
  check("translation failure resolves rather than hanging", Boolean(degraded));
  check("the original text survives a translation failure", degraded.includes("do you have time tomorrow"));
  check("a retry affordance is offered", (await ben.locator(`text=${es("panel.retry")}`).count()) > 0);

  // ---------------------------------------------------------------------
  section("Replies in the other direction");
  await ben.getByPlaceholder(es("composer.placeholder")).fill("si, despues de las tres");
  await ben.getByPlaceholder(es("composer.placeholder")).press("Enter");
  const anaSees = await waitFor(
    async () => {
      const text = await ana.locator(".transcript").textContent();
      return text.includes("si, despues de las tres") ? text : null;
    },
    "Ana to receive the reply",
  );
  check("messages flow both ways", Boolean(anaSees));

  // ---------------------------------------------------------------------
  section("Subtitles fade when nobody is talking");
  // A subtitle is for reading something just said, not a caption that stays until it is
  // replaced. Left up, the last sentence sits over the video for the rest of the call.
  //
  // Chat lines drive the same overlay as speech, which is what makes this testable without
  // being able to fake a microphone.
  const overlayOpacity = () =>
    ana.evaluate(() => {
      const el = document.querySelector(".subtitles");
      return el ? Number(getComputedStyle(el).opacity) : -1;
    });

  check("the line is visible right after it arrives", (await overlayOpacity()) > 0.9);

  check(
    "and has faded a few seconds later",
    await waitFor(async () => ((await overlayOpacity()) < 0.05 ? true : null), "the fade", 8_000)
      .catch(() => false),
  );

  // Coming back has to be instant, or the next thing said is missed while it fades in.
  await ben.getByPlaceholder(es("composer.placeholder")).fill("one more thing");
  await ben.getByPlaceholder(es("composer.placeholder")).press("Enter");
  check(
    "a new line brings the subtitles straight back",
    await waitFor(async () => ((await overlayOpacity()) > 0.9 ? true : null), "the return", 5_000)
      .catch(() => false),
  );

  // ---------------------------------------------------------------------
  section("Correction affordances");
  await ana.getByPlaceholder("Type a message").fill("the standup is at nine");
  await ana.getByPlaceholder("Type a message").press("Enter");
  await waitFor(
    async () => {
      const text = await ben.locator(".transcript").textContent();
      return text.includes("the standup is at nine") ? text : null;
    },
    "the line to arrive",
  );

  // With translation off, a failed line must offer RETRY and not a correction affordance:
  // there is nothing to correct yet. Verify that distinction holds rather than assume it.
  const retryCount = await ben.locator(`text=${es("panel.retry")}`).count();
  const fixCount = await ben.locator(`text=${es("panel.fix")}`).count();
  check("a failed line offers retry, not a correction", retryCount > 0 && fixCount === 0);

  // ---------------------------------------------------------------------
  section("Transcript panel");
  const rows = await ben.locator(".line").count();
  check("every line is listed in the transcript", rows >= 3);
  // These two used to be one check asserting an .o row on EVERY line, and it was wrong in the
  // most awkward way: it passed, and what it pinned was a bug.
  //
  // This run starts the server with no ANTHROPIC_API_KEY on purpose, so every line here is a
  // FAILED line, and a failed line gets translated set to its own text. That is deliberate: the
  // screen shows the words rather than a blank row or a spinner that never resolves. But the
  // small .o row exists to show the original BESIDE a translation, so on these lines it printed
  // the same sentence twice, large and then again small italic beneath. The old check counted
  // exactly those duplicate rows and required them to be there.
  //
  // What has to hold is that each sentence appears once and is not dropped along with its
  // duplicate, so both halves are asserted rather than a count that cannot tell them apart.
  check(
    "a line whose translation failed shows its text once, not twice",
    (await ben.locator(".line .o").count()) === 0,
  );
  const lastRow = await ben.locator(".line").last().innerText();
  check(
    "and the text is still on screen rather than removed with the duplicate",
    lastRow.split("the standup is at nine").length - 1 === 1,
  );
  // Nobody downloads the transcript any more (owner decision, 2026-09-28).
  check(
    "no transcript download is offered, in any format",
    (await ben.locator(".panel-head button").count()) === 0 &&
      !/\.txt|\.json/i.test(await ben.locator(".panel").innerText()),
  );

  // ---------------------------------------------------------------------
  section("Turning translation off");
  await openSettings(ana);
  await ana.getByRole("button", { name: translationButton("on") }).click();

  check(
    "the other person is told, so their own lines going untranslated is explained",
    await waitFor(
      async () => (await ben.locator(`text=${es("chips.translationOff")}`).count()) > 0,
      "Ben to see the translation off chip",
    ).catch(() => false),
  );

  // Ben speaks. Ana is the one who would read it and she does not want it, so this line must
  // resolve immediately rather than sitting on "translating..." or failing.
  await ben.getByPlaceholder(es("composer.placeholder")).fill("esto no se traduce");
  await ben.getByPlaceholder(es("composer.placeholder")).press("Enter");
  const skippedArrived = await waitFor(
    async () => {
      const text = await ana.locator(".transcript").textContent();
      return text.includes("esto no se traduce") ? text : null;
    },
    "the untranslated line to arrive",
  ).catch(() => null);
  check("a line nobody wants translated still arrives", Boolean(skippedArrived));
  check(
    "and it resolves rather than translating forever",
    !(await ana.locator(".line").last().innerText()).includes("translating..."),
  );
  // Counted inside the row itself rather than by diffing an .o row count against the number of
  // lines. The old form could only see a duplicate if lines that were NOT duplicated still
  // carried an .o row, which stopped being true once a failed line stopped repeating itself.
  const skippedRow = await ana.locator(".line").last().innerText();
  check(
    "and it is shown once rather than duplicated as its own original",
    skippedRow.split("esto no se traduce").length - 1 === 1,
  );

  await openSettings(ana);
  await ana.getByRole("button", { name: translationButton("off") }).click();
  check(
    "turning it back on clears the chip",
    await waitFor(
      async () => (await ben.locator(`text=${es("chips.translationOff")}`).count()) === 0,
      "the chip to clear",
    ).catch(() => false),
  );

  // ---------------------------------------------------------------------
  section("Camera off and back on");
  // Named for what it does to YOUR camera. The visible label is abbreviated to fit beside the
  // self view, so the accessible name is the one to drive from.
  await ana.getByRole("button", { name: "Turn your camera off" }).click();
  check(
    "the other person sees a placeholder naming them, not a frozen frame",
    await waitFor(async () => {
      const placeholder = ben.locator(".video-area > .placeholder");
      if ((await placeholder.count()) === 0) return null;
      return (await placeholder.innerText()).includes("Ana") ? true : null;
    }, "Ben to see Ana's camera off placeholder").catch(() => false),
  );

  // The half that matters. The <video> is mounted conditionally, so coming back means a FRESH
  // element, and the effect that assigns srcObject has to run again for it. When it did not, the
  // video came back permanently black with nothing logged anywhere.
  await ana.getByRole("button", { name: "Turn your camera on" }).click();
  check(
    "and the video comes back when they turn it on again",
    await waitFor(
      // Same correction as above: a direct child, and a live video track rather than merely an
      // assigned srcObject. Against the self view this passed while the peer showed nothing.
      async () => ((await ben.evaluate(remoteVideoLive)) ? true : null),
      "Ana's video to come back",
    ).catch(() => false),
  );

  // ---------------------------------------------------------------------
  section("Turning a camera on after an audio only join");
  // A fresh room, not Ana and Ben's: both of them joined WITH video from the start, so their room
  // can never exercise the case the disabled button used to make permanent, someone who unchecked
  // the camera box at the prejoin screen. New room, new pair.
  const contextFin = await signedInContext("Fin", { permissions: ["microphone", "camera"] });
  const contextGia = await signedInContext("Gia", { permissions: ["microphone", "camera"] });
  const fin = await contextFin.newPage();
  const gia = await contextGia.newPage();
  pages.fin = fin;
  pages.gia = gia;
  for (const [name, page] of [["fin", fin], ["gia", gia]]) {
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  }

  await fin.goto(BASE);
  await fin.getByRole("button", { name: "Start a new chat" }).click();
  await fin.getByLabel("Your name, just for this chat").fill("Fin");
  await fin.getByLabel(/Turn my camera on/).uncheck();
  await fin.getByRole("button", { name: /Create and allow microphone/ }).click();

  const secondCode = await waitFor(async () => {
    const text = await fin.locator(".code-badge").textContent().catch(() => null);
    return text && text.trim().length === 8 ? text.trim() : null;
  }, "a second room code");

  await gia.goto(BASE);
  await gia.getByLabel("Room code").fill(secondCode);
  await gia.getByRole("button", { name: "Join chat" }).click();
  await gia.getByLabel("Your name, just for this chat").fill("Gia");
  await gia.getByRole("button", { name: /Join and allow microphone/ }).click();
  await waitFor(async () => gia.locator(".room").isVisible(), "Gia to enter the room");

  check(
    "Gia sees Fin joined without a camera, not a frozen or blank frame",
    await waitFor(async () => {
      const placeholder = gia.locator(".video-area > .placeholder");
      if ((await placeholder.count()) === 0) return null;
      return (await placeholder.innerText()).includes("Fin") ? true : null;
    }, "Gia to see Fin's no camera placeholder").catch(() => false),
  );

  check(
    "Fin's camera control is usable rather than permanently disabled",
    await fin.getByRole("button", { name: "Turn your camera on" }).isEnabled(),
  );

  await fin.getByRole("button", { name: "Turn your camera on" }).click();

  check(
    "Gia's view switches to live video once Fin turns the camera on, with neither side rejoining",
    await waitFor(
      async () => ((await gia.evaluate(remoteVideoLive)) ? true : null),
      "Fin's video to reach Gia",
      20_000,
    ).catch(() => false),
  );
  check(
    "Fin's own self view shows the camera too",
    (await fin.locator(".self-view video").count()) > 0,
  );
  check(
    "Gia's placeholder stops naming Fin as cameraless",
    (await gia.locator(".video-area > .placeholder").count()) === 0,
  );

  await contextFin.close();
  await contextGia.close();

  // ---------------------------------------------------------------------
  section("Leaving while the camera permission prompt is still open");
  // The part of turning a camera on that a unit test cannot reach: turnOnCamera awaits a
  // PERMISSION PROMPT, and a person can leave the call while it sits there. The continuation then
  // runs for a call that no longer exists.
  //
  // This browser grants permission instantly, so the window is opened on purpose: the VIDEO ONLY
  // request, which is the one turnOnCamera makes and the prejoin request never does, is held for
  // a few seconds before it is allowed to resolve. Every track it hands back is recorded, because
  // the symptom is invisible to the UI. A track nobody stops is a camera light that stays on for
  // the life of the tab, long after the room is gone.
  const HELD_MS = 4_000;
  const contextHal = await signedInContext("Hal", { permissions: ["microphone", "camera"] });
  await contextHal.addInitScript((heldMs) => {
    window.__cameraTracks = [];
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const videoOnly = Boolean(constraints?.video) && !constraints?.audio;
      if (videoOnly) await new Promise((resolve) => setTimeout(resolve, heldMs));
      const stream = await real(constraints);
      if (videoOnly) window.__cameraTracks.push(...stream.getVideoTracks());
      return stream;
    };
  }, HELD_MS);
  const hal = await contextHal.newPage();
  pages.hal = hal;
  hal.on("pageerror", (e) => errors.push(`hal: ${e.message}`));

  await hal.goto(BASE);
  await hal.getByRole("button", { name: "Start a new chat" }).click();
  await hal.getByLabel("Your name, just for this chat").fill("Hal");
  await hal.getByLabel(/Turn my camera on/).uncheck();
  await hal.getByRole("button", { name: /Create and allow microphone/ }).click();
  await waitFor(async () => hal.locator(".room").isVisible(), "Hal to enter the room");

  // The click returns immediately; the camera behind it does not arrive for HELD_MS. Leaving now
  // is the race, and it is the ordinary way out of a call, not a contrived one.
  await hal.getByRole("button", { name: "Turn your camera on" }).click();
  await openSettings(hal);
  await hal.getByRole("button", { name: "Leave chat" }).click();
  await waitFor(
    async () => ((await hal.locator("body").innerText()).includes("Chat over") ? true : null),
    "Hal to be out of the room before the camera arrives",
  );

  check(
    "the camera really did arrive after the room was gone, so this raced what it meant to",
    await waitFor(
      async () => ((await hal.evaluate(() => window.__cameraTracks.length)) > 0 ? true : null),
      "Hal's held camera request to resolve",
      HELD_MS + 10_000,
    ).catch(() => false),
  );
  check(
    "the late camera is stopped rather than left running for the life of the tab",
    await hal.evaluate(() => window.__cameraTracks.every((t) => t.readyState === "ended")),
  );

  await contextHal.close();

  // ---------------------------------------------------------------------
  section("Surviving a reload");
  await ben.reload();
  const backUp = await waitFor(
    async () => {
      const text = await ben.locator("body").innerText();
      return text.length > 0 ? text : null;
    },
    "Ben's page to come back",
  );
  check("a reload lands on a usable page rather than a blank one", backUp.length > 0);
  // A reload drops the seat, so Ben lands on the same first screen anybody else would. It may
  // paint in the browser's English for the moment before his stored preference arrives.
  check(
    "the room code is remembered for rejoining",
    [en("landing.codeLabel"), en("panel.title"), es("landing.codeLabel"), es("panel.title")].some((t) =>
      backUp.includes(t),
    ),
  );
  // Ben picked es-AR before his first join, and that choice is stored on his account (M5), so
  // the page settles in his dialect rather than staying in the browser's English.
  const inHisDialect = await waitFor(
    async () => ((await ben.locator("body").innerText()).includes(es("landing.join")) ? true : null),
    "Ben's stored dialect to apply after the reload",
  );
  check("a reload restores the dialect stored on the account", inHisDialect === true);

  // Put Ben back in the room. A reload drops the media permission grant, so he rejoins through
  // the form exactly as a real person would after refreshing. The picker already reads es-AR,
  // from the stored preference, so it is left alone.
  if (!(await ben.locator(".room").isVisible())) {
    await ben.getByLabel(es("landing.codeLabel")).fill(code);
    await ben.getByRole("button", { name: es("landing.join") }).click();
    await ben.getByLabel(es("prejoin.name.label")).fill("Ben");
    check(
      "the pre join dialect defaults from the stored preference",
      (await ben.getByLabel(es("prejoin.dialect.label")).inputValue()) === "es-AR",
    );
    await ben.getByRole("button", { name: es("prejoin.submit.join") }).click();
    await waitFor(async () => ben.locator(".room").isVisible(), "Ben to rejoin after reloading");
  }
  check("rejoining after a reload works and restores the conversation",
    (await ben.locator(".transcript").innerText()).includes("do you have time tomorrow"));

  // ---------------------------------------------------------------------
  section("Room capacity");
  const cam = await (await signedInContext("Cam", { permissions: ["microphone"] })).newPage();
  await cam.goto(BASE);
  await cam.getByLabel("Room code").fill(code);
  await cam.getByRole("button", { name: "Join chat" }).click();
  await cam.getByLabel("Your name, just for this chat").fill("Cam");
  await cam.getByRole("button", { name: /Join and allow microphone/ }).click();

  const refused = await waitFor(
    async () => {
      const text = await cam.locator("body").textContent();
      return /already has two people/i.test(text) ? text : null;
    },
    "the third person to be refused",
  ).catch(() => null);
  check("a third person is refused with a clear reason", Boolean(refused));

  // ---------------------------------------------------------------------
  section("Leaving reopens the seat");
  await openSettings(ben);
  await ben.getByRole("button", { name: es("room.leave") }).click();
  await waitFor(
    async () => (await ana.locator(".names").textContent()).includes("waiting"),
    "Ana to see Ben leave",
  );
  check("the remaining person sees the seat reopen", true);

  await cam.reload();
  await cam.getByLabel("Room code").fill(code);
  await cam.getByRole("button", { name: "Join chat" }).click();
  await cam.getByLabel("Your name, just for this chat").fill("Cam");
  await cam.getByRole("button", { name: /Join and allow microphone/ }).click();
  await waitFor(async () => cam.locator(".room").isVisible(), "Cam to take the free seat");
  check("someone new can take the freed seat", true);

  check(
    "the new arrival receives the conversation so far",
    (await cam.locator(".transcript").textContent()).includes("do you have time tomorrow"),
  );

  // The half of "reopens the seat" that nothing checked. peer.left had no case in App.tsx, so the
  // old PeerConnection outlived the person it belonged to and startPeer's `if (peer.current)`
  // guard made Cam reuse it. Cam's tracks were appended to a stream still holding Ben's ended
  // ones, and the video element binds to the FIRST video track, which was Ben's dead one. What
  // Ana saw was a frozen frame of the person who had left.
  // Media has to reach the REPLACEMENT peer, not just the first one. Worth guarding on its own:
  // everything above this point only ever exercised the original pair.
  //
  // It does NOT isolate the peer.left teardown in App.tsx. That was tried: both "is the first
  // video track live" and "is there exactly one video track" still pass with the teardown deleted,
  // so neither distinguishes a rebuilt connection from an inherited one under this harness. The
  // check is kept for what it does cover, and the teardown is stated as untested rather than
  // guarded by something that cannot fail.
  check(
    "media reaches the new arrival too, not only the original pair",
    await waitFor(
      async () => {
        const anaSeesCam = await ana.evaluate(remoteVideoLive);
        const camSeesAna = await cam.evaluate(remoteVideoLive);
        return anaSeesCam && camSeesAna ? true : null;
      },
      "media to flow between Ana and Cam",
      20_000,
    ).catch(() => false),
  );

  // ---------------------------------------------------------------------
  section("A phone sized screen");
  // Three bugs came back from a real iPhone that nothing above could have caught, because
  // Playwright's default viewport is 1280x720 and every check so far exercised the desktop
  // layout. On iOS Safari 100vh is the viewport measured as though the URL bar were hidden, so
  // the page scrolled, the settings drawer could be reached by scrolling toward it, and its last
  // row sat below the fold where it could not be tapped at all.
  const phoneContext = await signedInContext("Dana", {
    viewport: { width: 390, height: 844 },
    permissions: ["microphone", "camera"],
  });
  const phone = await phoneContext.newPage();
  phone.on("pageerror", (e) => errors.push(`phone: ${e.message}`));
  await phone.goto(BASE);
  await phone.getByRole("button", { name: "Start a new chat" }).click();
  await phone.getByLabel("Your name, just for this chat").fill("Dana");
  await phone.getByRole("button", { name: /Create and allow microphone/ }).click();
  await waitFor(async () => phone.locator(".room").isVisible(), "Dana to enter the room");

  check(
    "the page does not scroll, so the drawer cannot be reached by scrolling toward it",
    await phone.evaluate(() => document.scrollingElement.scrollHeight <= window.innerHeight + 1),
  );

  await phone.getByPlaceholder("Type a message").fill("checking the drawer");
  await phone.getByPlaceholder("Type a message").press("Enter");
  await openSettings(phone);

  check(
    "the settings drawer does not repeat the newest chat line",
    !(await phone.locator("#control-drawer").textContent()).includes("checking the drawer"),
  );

  const endChat = phone.getByRole("button", { name: "End chat" });
  check(
    "End chat lands inside the viewport rather than below the fold",
    await waitFor(async () => {
      const box = await endChat.boundingBox();
      if (!box) return null;
      const viewport = await phone.evaluate(() => window.innerHeight);
      return box.y >= 0 && box.y + box.height <= viewport ? true : null;
    }, "End chat to land on screen").catch(() => false),
  );

  check(
    "and it can actually be pressed",
    await endChat
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false),
  );
  await phone.getByRole("button", { name: "Cancel" }).click();
  await phoneContext.close();

  // ---------------------------------------------------------------------
  section("Saved corrections, on a phone, in Spanish");
  // The backstop for what the after call screen cannot see (owner decision C5). The server tests
  // carry saving them, since this run has no API key and so never reaches a correction; this is
  // the list a person reads and deletes from, at 390 pixels, in the language that runs longest.
  const fayContext = await signedInContext("Fay", { viewport: { width: 390, height: 844 } });
  const fayToken = (await apiSignIn(BASE, "Fay")).accessToken;
  const fayHeaders = { "content-type": "application/json", authorization: `Bearer ${fayToken}` };
  const longFix =
    "cuando termina la reunión de la mañana, la que todos llaman la daily, aunque nadie sepa bien por qué ".repeat(3).trim();
  const fayEntries = [
    { source: "the standup", target: longFix, sourceDialect: "en-US", targetDialect: "es-AR" },
    { source: "deadline", target: "fecha límite", sourceDialect: "en-US", targetDialect: "es-AR" },
  ];
  await fetch(`${BASE}/api/me/preferences`, {
    method: "PUT",
    headers: fayHeaders,
    body: JSON.stringify({ dialect: "es-AR", uiDialect: "es-AR" }),
  });
  await fetch(`${BASE}/api/me/glossary`, { method: "PUT", headers: fayHeaders, body: JSON.stringify({ entries: fayEntries }) });
  const fay = await fayContext.newPage();
  fay.on("pageerror", (e) => errors.push(`fay: ${e.message}`));
  await fay.goto(BASE);
  const savedOpen = fay.getByRole("button", { name: es("saved.open") });
  await savedOpen.waitFor({ timeout: 10_000 });
  await savedOpen.click();
  check(
    "the list opens with focus on its heading",
    await waitFor(async () => ((await fay.evaluate(() => document.activeElement?.id)) === "saved-title" ? true : null), "focus on the heading")
      .catch(() => false),
  );
  await fay.locator(".saved-item").first().waitFor();
  check("every saved correction is listed", (await fay.locator(".saved-item").count()) === 2);
  check(
    "a long fix is shown in full, wrapped rather than cut",
    (await fay.locator(".saved-target").first().innerText()).replace(/\s+/g, " ").trim() === longFix,
  );
  check(
    "nothing on the page is wider than the phone",
    await fay.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth),
  );
  check(
    "no entry overflows its box",
    await fay.evaluate(() =>
      [...document.querySelectorAll(".saved-text, .saved-item > button")].every(
        (node) => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1,
      ),
    ),
  );
  await fay
    .getByRole("button", { name: es("saved.deleteLabel").replace("{source}", "deadline") })
    .click();
  await waitFor(async () => ((await fay.locator(".saved-item").count()) === 1 ? true : null), "the entry to go");
  const fayStored = await fetch(`${BASE}/api/me/glossary`, { headers: fayHeaders }).then((r) => r.json());
  check(
    "deleting one removes it from the account and keeps the other",
    JSON.stringify(fayStored.entries) === JSON.stringify([fayEntries[0]]),
    JSON.stringify(fayStored).slice(0, 200),
  );
  check(
    "after a delete, focus lands on the list's heading rather than on the page",
    (await fay.evaluate(() => document.activeElement?.id)) === "saved-title",
  );
  await fay.getByRole("button", { name: es("saved.close"), exact: true }).click();
  check(
    "closing puts focus back on the link that opened it",
    (await fay.evaluate(() => document.activeElement?.textContent)) === es("saved.open"),
  );
  await fayContext.close();

  // ---------------------------------------------------------------------
  section("Ending kills the room permanently");
  await openSettings(ana);
  await ana.getByRole("button", { name: "End chat" }).click();
  await ana.getByRole("button", { name: "End it for everyone" }).click();

  await waitFor(
    async () => (await cam.locator("body").textContent()).includes("ended the chat"),
    "Cam to be told the chat ended",
  );
  check("everyone is told the chat ended, and by whom", true);

  const rejoin = await signedInContext("Dee", { permissions: ["microphone"] }).then((c) => c.newPage());
  await rejoin.goto(BASE);
  await rejoin.getByLabel("Room code").fill(code);
  await rejoin.getByRole("button", { name: "Join chat" }).click();
  await rejoin.getByLabel("Your name, just for this chat").fill("Dee");
  await rejoin.getByRole("button", { name: /Join and allow microphone/ }).click();

  const dead = await waitFor(
    async () => {
      const text = await rejoin.locator("body").textContent();
      return /was ended and cannot be rejoined/i.test(text) ? text : null;
    },
    "the code to be refused after ending",
  ).catch(() => null);
  check("the code is dead after ending", Boolean(dead));

  // ---------------------------------------------------------------------
  section("The call is on the host's account");
  // Read through the API, as the iOS app will. The per user data service reaches the signaling
  // server only through index.ts, and dropping it there silently turned off call history and the
  // stored glossary with every other check green.
  const anaToken = (await apiSignIn(BASE, "Ana")).accessToken;
  const history = await fetch(`${BASE}/api/me/calls`, { headers: { authorization: `Bearer ${anaToken}` } })
    .then((r) => r.json())
    .catch(() => null);
  check(
    "the host's call history names the person who joined",
    Array.isArray(history?.calls) && history.calls.some((call) => call.peer?.displayName === "Ben"),
    JSON.stringify(history)?.slice(0, 200),
  );

  // ---------------------------------------------------------------------
  section("Deleting an account");
  // A page of its own, outside the console error watch above: the wrong password below answers
  // 401 on purpose, and so does the sign in attempt after the account is gone.
  const eve = await (await browser.newContext()).newPage();
  await signUpViaScreen(eve, "Eve");
  // Opening swaps the focused button for a form, and cancelling swaps it back. Focus left behind in
  // a node that is gone falls to <body>, which drops a keyboard user at the top of the page.
  await eve.getByRole("button", { name: en("account.delete.open") }).click();
  check(
    "opening it puts focus in the password field",
    (await eve.evaluate(() => document.activeElement?.id)) === "delete-password",
  );
  await eve.getByRole("button", { name: en("account.delete.cancel") }).click();
  check(
    "cancelling puts focus back on the button that opened it",
    (await eve.evaluate(() => document.activeElement?.textContent)) === en("account.delete.open"),
  );
  await eve.getByRole("button", { name: en("account.delete.open") }).click();
  await eve.getByLabel(en("account.delete.password")).fill("not the password");
  await eve.getByRole("button", { name: en("account.delete.confirm") }).click();
  check(
    "deleting needs the password: a wrong one is refused with a sentence",
    await eve
      .getByText(en("account.delete.wrongPassword"))
      .waitFor()
      .then(() => true)
      .catch(() => false),
  );
  // The submit button is disabled while the request runs, which drops its focus to <body>.
  check(
    "after a refusal, focus is back in the password field",
    (await eve.evaluate(() => document.activeElement?.id)) === "delete-password",
  );
  // Selected as well, ready to type over, and tied to the sentence that says why, so a screen
  // reader coming back to the field hears the refusal and not just the label.
  const retypeReady = () =>
    eve.evaluate(() => {
      const field = document.activeElement;
      return (
        field?.id === "delete-password" &&
        field.value.length > 0 &&
        field.selectionStart === 0 &&
        field.selectionEnd === field.value.length
      );
    });
  check("after a wrong password, the field is selected, ready to retype", await retypeReady());
  check(
    "the wrong password marks the field invalid and is tied to it",
    await eve.evaluate(() => {
      const field = document.getElementById("delete-password");
      const reason = document.getElementById(field?.getAttribute("aria-describedby") ?? "");
      return field?.getAttribute("aria-invalid") === "true" && reason?.getAttribute("role") === "alert";
    }),
  );
  // Every other refusal the same way, not just a wrong password: focused and selected, tied to its
  // sentence, and NOT marked invalid, since the password may well be right. Faked in this browser,
  // so none touches the server's real limits, which the rest of the run signs in through. The
  // expired sign in is answered for real by the refresh that follows it, so the tab stays signed in.
  // "Not invalid" is anything but aria-invalid="true": an absent attribute and "false" mean the
  // same to assistive technology, and either is a correct way to write it.
  const tiedNotInvalid = () =>
    eve.evaluate(() => {
      const field = document.getElementById("delete-password");
      const reason = document.getElementById(field?.getAttribute("aria-describedby") ?? "");
      return field !== null && field.getAttribute("aria-invalid") !== "true" && reason?.getAttribute("role") === "alert";
    });
  for (const [what, sentence, answer] of [
    [
      "a rate limit",
      en("auth.error.RATE_LIMITED"),
      (route) => route.fulfill({ status: 429, contentType: "application/json", body: '{"error":"RATE_LIMITED"}' }),
    ],
    ["a request that never got an answer", en("auth.error.unavailable"), (route) => route.abort()],
    [
      "an expired sign in",
      en("account.delete.expired"),
      (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"UNAUTHENTICATED"}' }),
    ],
  ]) {
    await eve.route("**/api/account", answer);
    await eve.getByRole("button", { name: en("account.delete.confirm") }).click();
    await eve.getByText(sentence).waitFor();
    check(`after ${what}, focus is back in the password field, selected`, await retypeReady());
    check(`after ${what}, the refusal is tied to the field, which is not marked invalid`, await tiedNotInvalid());
    await eve.unroute("**/api/account");
  }
  await eve.getByLabel(en("account.delete.password")).fill(PASSWORD);
  await eve.getByRole("button", { name: en("account.delete.confirm") }).click();
  check(
    "the right password deletes the account and signs out",
    await eve
      .getByRole("button", { name: en("auth.submit.signIn") })
      .waitFor()
      .then(() => true)
      .catch(() => false),
  );
  await eve.getByLabel(en("auth.email")).fill(emailFor("Eve"));
  await eve.getByLabel(en("auth.password")).fill(PASSWORD);
  await eve.getByRole("button", { name: en("auth.submit.signIn") }).click();
  check(
    "and the deleted account can no longer sign in",
    await eve
      .getByText(en("auth.error.INVALID_CREDENTIALS"))
      .waitFor()
      .then(() => true)
      .catch(() => false),
  );

  // ---------------------------------------------------------------------
  section("Invite only signup, the default a real deployment runs");
  // Everything above runs with open signup so the harness can make accounts freely, which left
  // the production default untested end to end: the client could stop sending the code, or the
  // owner lose the control that mints one, and every check above still passed. A server and a
  // database of its own, so no account from above exists here.
  const inviteRoot = join(root, "invite-only");
  inviteServer = startServer({
    ...process.env,
    PORT: "0",
    NODE_ENV: "development",
    ANTHROPIC_API_KEY: "",
    ...accountsEnv(inviteRoot),
    SIGNUP_MODE: "invite",
    OWNER_EMAIL: emailFor("Olga"),
  });
  const inviteLog = [];
  inviteServer.stdout.on("data", (d) => inviteLog.push(String(d)));
  inviteServer.stderr.on("data", (d) => inviteLog.push(String(d)));
  const invitePort = await waitFor(
    async () => inviteLog.join("").match(/"event":"listening","port":(\d+)/)?.[1] ?? null,
    "the invite only server to report its port",
  );
  const INVITE_BASE = `http://localhost:${invitePort}`;

  // The first code the way DEPLOY.md tells the owner to mint it: the BUILT CLI, which is what the
  // image ships, run on the host against the database the live server has open.
  const cli = spawnSync(process.execPath, ["server/dist/cli/invite.js"], {
    encoding: "utf8",
    env: { ...process.env, DATA_DIR: join(inviteRoot, "data"), OWNER_EMAIL: "" },
  });
  const INVITE_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/;
  const firstCode = (cli.stdout ?? "").split("\n")[0]?.trim() ?? "";
  check("the invite CLI prints a code", INVITE_CODE.test(firstCode), (cli.stderr ?? "").slice(0, 200));

  const olga = await (await browser.newContext()).newPage();
  await openSignUp(olga, INVITE_BASE);
  check("an invite only server asks for an invite code", await olga.getByLabel(en("auth.invite")).isVisible());
  await submitSignUp(olga, "Olga", firstCode);
  check(
    "the owner signs up with the code from the CLI",
    await reached(olga.getByRole("button", { name: "Start a new chat" })),
  );

  await olga.getByRole("button", { name: en("account.invite.create") }).click();
  const minted = await waitFor(
    async () => (await olga.locator(".owner-invite-code").textContent().catch(() => null))?.trim() || null,
    "the owner's new invite code",
  );
  check("the owner mints an invite in the app", INVITE_CODE.test(minted), minted);

  const pat = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
  await openSignUp(pat, INVITE_BASE);
  await submitSignUp(pat, "Pat", minted);
  check(
    "someone invited signs up with the code the owner sent",
    await reached(pat.getByRole("button", { name: "Start a new chat" })),
  );

  const quin = await (await browser.newContext()).newPage();
  await openSignUp(quin, INVITE_BASE);
  await submitSignUp(quin, "Quin", minted);
  check("a code already used is refused with a sentence", await reached(quin.getByText(en("auth.error.INVITE_INVALID"))));

  // A returning visitor's first render is the start page, restoring, never the sign in form. The
  // session state used to be set in a mount effect, so the form was mounted first on every load.
  // The observer reads what was INSERTED, not what is in the document when it runs: React can
  // mount the form and swap it out within one task, before an observer's callback ever sees the
  // live DOM, and a querySelector there passed with the form mounted on every load.
  // The positive control first: the same observer, on a signed out load, has to see the form, or
  // "never saw it" below proves nothing.
  const control = await (await browser.newContext()).newPage();
  await control.addInitScript(watchForSignInForm);
  await control.goto(INVITE_BASE);
  await control.getByLabel(en("auth.email")).waitFor();
  check(
    "the first render watcher sees the sign in form on a signed out load",
    (await control.evaluate(() => window.__sawSignInForm)) === true,
  );
  await pat.addInitScript(watchForSignInForm);
  await pat.reload();
  await pat.getByRole("button", { name: "Start a new chat" }).waitFor();
  check(
    "a returning visitor never sees the sign in form, not even for a frame",
    (await pat.evaluate(() => window.__sawSignInForm)) === false,
  );
  // Nothing in the account strip takes focus on its own when the start page loads: focus on
  // "Delete account" is one Enter from the deletion form, and on "Sign out" one Enter from signing
  // out. Checked once the strip has mounted and its effects have run (checked before that, it
  // passed on a race), and only the strip: focus a design puts elsewhere on purpose is fine.
  await pat.locator(".account-state").waitFor();
  await pat.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check(
    "the start page loads with nothing in the account strip focused",
    await pat.evaluate(() => !document.activeElement?.closest(".account-strip")),
  );

  // Deleted from somewhere else mid call: the tab has to notice on its own and go to the sign in
  // screen, not sit in a room its account no longer exists for. It hears through the socket the
  // server closes, then a refresh the server refuses (App.tsx, onSignedOut).
  await pat.getByRole("button", { name: "Start a new chat" }).click();
  await pat.getByLabel("Your name, just for this chat").fill("Pat");
  await pat.getByLabel("Your language and region").selectOption("en-US");
  await pat.getByRole("button", { name: /Create and allow microphone/ }).click();
  await pat.locator(".room").waitFor();
  const deletedElsewhere = await apiDeleteAccount(INVITE_BASE, await apiSignIn(INVITE_BASE, "Pat"));
  check("the account is deleted from somewhere else", deletedElsewhere === 204, String(deletedElsewhere));
  check(
    "the tab that was in a call goes to the sign in screen on its own",
    await reached(pat.getByRole("button", { name: en("auth.submit.signIn") })),
  );
  // Saying it was signed out, not that another account took the tab: the call's end tells the two
  // apart, and counting every end as a move put the wrong sentence here (measured in review).
  check("and says why, as a sign out", await reached(announced(pat, en("error.UNAUTHENTICATED"))));

  // ---------------------------------------------------------------------
  section("A call in a tab moved to another account ends, and says why");
  // A call's socket asks for a token before every connect, and tabs share one sign in, so a tab
  // another tab moved to a new account used to reconnect as that account. Measured in review:
  // after an outage past the 60 s grace window, the call took its seat back as the new account
  // under the old one's name, and both accounts' history and contacts gained a call one of them
  // never had. The damage needs the grace window; the guard does not. A reconnect that follows a
  // failed one forces a refresh, which is where the tab changes accounts, and from there no socket
  // may reach the server, and the call has to end and say why. Olga hosts. Ivy is in the call in
  // one tab, and in another tab of the same browser she signs out and Jon signs in.
  const olgaHosting = await apiSignIn(INVITE_BASE, "Olga");
  const ivy = await apiInviteSignUp(INVITE_BASE, olgaHosting, "Ivy");
  const jon = await apiInviteSignUp(INVITE_BASE, olgaHosting, "Jon");
  const hostContext = await contextSignedInWith(INVITE_BASE, olgaHosting.refreshToken, { permissions: ["microphone"] });
  const host = await hostContext.newPage();
  host.on("pageerror", (e) => errors.push(`host: ${e.message}`));
  await host.goto(INVITE_BASE);
  await host.getByRole("button", { name: "Start a new chat" }).click();
  await host.getByLabel("Your name, just for this chat").fill("Olga");
  await host.getByLabel("Your language and region").selectOption("en-US");
  await host.getByRole("button", { name: /Create and allow microphone/ }).click();
  const callCode = await waitFor(
    async () => {
      const text = await host.locator(".code-badge").textContent().catch(() => null);
      return text && text.trim().length === 8 ? text.trim() : null;
    },
    "a room code on the invite only server",
  );
  const ivyBrowser = await contextSignedInWith(INVITE_BASE, ivy.refreshToken, { permissions: ["microphone"] });
  await ivyBrowser.addInitScript(socketOutageSwitch, `ws://127.0.0.1:${await closedPort()}/`);
  const inCall = await ivyBrowser.newPage();
  const otherTab = await ivyBrowser.newPage();
  for (const [name, page] of [["the tab in the call", inCall], ["the other tab", otherTab]]) {
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  }
  await inCall.goto(INVITE_BASE);
  await inCall.getByLabel("Room code").fill(callCode);
  await inCall.getByRole("button", { name: "Join chat" }).click();
  await inCall.getByLabel("Your name, just for this chat").fill("Ivy");
  await inCall.getByLabel("Your language and region").selectOption("en-US");
  await inCall.getByRole("button", { name: en("prejoin.submit.join") }).click();
  await inCall.locator(".room").waitFor();
  await waitFor(async () => (await host.locator(".names").textContent()).includes("Ivy"), "the host to see Ivy");
  await otherTab.goto(INVITE_BASE);
  // Once the page has restored: Sign out shows while it restores, and a click that lands before
  // the restore answers is a race of its own (session.test.ts).
  await otherTab.locator(".account-state", { hasText: "Ivy" }).waitFor();
  await otherTab.getByRole("button", { name: en("account.signOut") }).click();
  await otherTab.getByLabel(en("auth.email")).fill(emailFor("Jon"));
  await otherTab.getByLabel(en("auth.password")).fill(PASSWORD);
  await otherTab.getByRole("button", { name: en("auth.submit.signIn") }).click();
  await otherTab.locator(".account-state", { hasText: "Jon" }).waitFor();
  check(
    "a tab is in a call while another tab of its browser signs in as someone else",
    (await inCall.locator(".room").count()) === 1,
  );
  // The control for the socket check below: the call's own sockets are read as Ivy's.
  check(
    "the call's socket speaks for the account it was joined as",
    (await inCall.evaluate(() => window.__protocols)).map(accountOfSocket).includes(ivy.user.id),
  );
  // A few seconds of outage: the socket drops, a reconnect fails, and the network comes back.
  await inCall.evaluate(() => {
    window.__offline = true;
    for (const socket of window.__sockets) socket.close(3000, "outage");
  });
  await waitFor(async () => (await inCall.evaluate(() => window.__failedWhileOffline)) > 0, "a reconnect to fail");
  const socketsBefore = await inCall.evaluate(() => {
    window.__offline = false;
    return window.__sockets.length;
  });
  check(
    "when the network comes back, the call ends and says the tab is on another account now",
    await reached(announced(inCall, en("error.ACCOUNT_CHANGED"))),
  );
  check("and the tab has left the call", (await inCall.locator(".room").count()) === 0);
  // The property itself, not only its notice: the old token source opened one as Jon here, and
  // was refused only because Ivy's seat was still held (measured in review). Read from each
  // socket's own bearer, so a design that reconnected as Ivy would pass.
  check(
    "and no socket reached the server as the account the tab moved to",
    !(await inCall.evaluate((before) => window.__protocols.slice(before), socketsBefore))
      .map(accountOfSocket)
      .includes(jon.user.id),
  );
  // And the tab can call again, as the account it holds now: a call object kept for the page's
  // life, rather than made for each call, ended every later call at once as a move, with every
  // check above green (measured in review).
  const socketsBeforeNewCall = await inCall.evaluate(() => window.__protocols.length);
  await inCall.getByRole("button", { name: "Start a new chat" }).click();
  await inCall.getByLabel("Your name, just for this chat").fill("Jon");
  await inCall.getByLabel("Your language and region").selectOption("en-US");
  await inCall.getByRole("button", { name: /Create and allow microphone/ }).click();
  check(
    "and it can start a new call",
    await waitFor(
      async () => ((await inCall.locator(".code-badge").textContent().catch(() => null)) ?? "").trim().length === 8,
      "a room code in the moved tab",
    ).catch(() => false),
  );
  check(
    "and that call's socket speaks for the account the tab holds now",
    (await inCall.evaluate((before) => window.__protocols.slice(before), socketsBeforeNewCall))
      .map(accountOfSocket)
      .includes(jon.user.id),
  );
  await ivyBrowser.close();
  await hostContext.close();

  // ---------------------------------------------------------------------
  section("Two tabs of one browser share one sign in");
  // Tabs share the stored refresh token, so signing in as someone else in one tab moves every
  // other tab to that account at its next refresh. Nothing the tab left behind shows for its old
  // account may act on the new one. Measured in review: the tab's bearer was refused (its account
  // deleted elsewhere), its refresh read the other account's token, the deletion form said to try
  // again, and one Enter with the password the two shared (as every account here does) deleted
  // the other account; and the owner's minted invite code stayed on screen for an account that is
  // not the owner. On this server, so its accounts do not spend the main server's signup limit.
  // Olga is the owner, and ends this section deleted: nothing after it uses her.
  const olgaSession = await apiSignIn(INVITE_BASE, "Olga");
  await apiInviteSignUp(INVITE_BASE, olgaSession, "Gus");
  const sharedBrowser = await contextSignedInWith(INVITE_BASE, olgaSession.refreshToken);
  const tabA = await sharedBrowser.newPage();
  const tabB = await sharedBrowser.newPage();
  for (const [name, page] of [["tab A", tabA], ["tab B", tabB]]) {
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  }
  await tabA.goto(INVITE_BASE);
  await tabA.locator(".account-state", { hasText: "Olga" }).waitFor();
  await tabA.getByRole("button", { name: en("account.invite.create") }).click();
  await tabA.locator(".owner-invite-code").waitFor();
  await tabB.goto(INVITE_BASE);
  await tabB.locator(".account-state", { hasText: "Olga" }).waitFor();
  await tabB.getByRole("button", { name: en("account.signOut") }).click();
  await tabB.getByLabel(en("auth.email")).fill(emailFor("Gus"));
  await tabB.getByLabel(en("auth.password")).fill(PASSWORD);
  await tabB.getByRole("button", { name: en("auth.submit.signIn") }).click();
  await tabB.locator(".account-state", { hasText: "Gus" }).waitFor();
  const olgaGone = await apiDeleteAccount(INVITE_BASE, await apiSignIn(INVITE_BASE, "Olga"));
  check(
    "an account is deleted on another device while a tab still shows it",
    olgaGone === 204 && (await tabA.locator(".account-state").innerText()).includes("Olga"),
    String(olgaGone),
  );
  await tabA.bringToFront();
  await tabA.getByRole("button", { name: en("account.delete.open") }).click();
  await tabA.getByLabel(en("account.delete.password")).fill(PASSWORD);
  await tabA.getByRole("button", { name: en("account.delete.confirm") }).click();
  check(
    "the tab left behind moves to the account the other tab signed in to",
    await reached(tabA.locator(".account-state", { hasText: "Gus" })),
  );
  // Either way the form was opened for the old account: gone with it, or saying so. Both are
  // right; what is not is a form that offers to go on as if nothing changed.
  check(
    "and the deletion form opened for the old account is gone, or says the tab changed accounts",
    (await tabA.locator("#delete-password").count()) === 0 ||
      (await tabA.getByText(en("account.delete.changed")).isVisible()),
  );
  check(
    "and the owner's invite code does not stay on screen for an account that is not the owner",
    (await tabA.locator(".owner-invite-code").count()) === 0,
  );
  // What "try again" had them do. Given a moment to land, in case it sent anything.
  await tabA.keyboard.press("Enter");
  await tabA.getByRole("button", { name: en("auth.submit.signIn") }).waitFor({ timeout: 3000 }).catch(() => null);
  const gusAfter = await fetch(`${INVITE_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: emailFor("Gus"), password: PASSWORD }),
  });
  check("the account the tab was moved to is not deleted", gusAfter.status === 200, String(gusAfter.status));
  await sharedBrowser.close();
  check("the invite only server answers until it is stopped", await answers(INVITE_BASE));
  stopServer(inviteServer);
  inviteServer = null;
  check("the invite only server is gone once stopped", await goneWithin(INVITE_BASE, 5000));

  // ---------------------------------------------------------------------
  section("Credentials stay out of URLs");
  check(
    "the socket was opened, and no socket URL carries a token",
    socketUrls.length > 0 && socketUrls.every((url) => !/bearer|token|access/i.test(url)),
    socketUrls.join(" "),
  );

  // ---------------------------------------------------------------------
  section("Page health");
  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
  checks += 1;
  failures += 1;
  console.error(`\nFATAL: ${error.message}`);
  // Dump what each page was actually showing. A timeout with no context turns a five minute
  // fix into an hour of guessing, and this harness is the only witness to what happened.
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
  stopServer(inviteServer);
  if (BASE !== "") {
    section("Shutdown");
    check("the server answers until it is stopped", await answers(BASE));
    stopServer(server);
    check("the server is gone once stopped, so a run leaves nothing running", await goneWithin(BASE, 5000));
  } else {
    stopServer(server);
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${checks - failures} of ${checks} checks passed.`);
process.exit(failures === 0 ? 0 : 1);
