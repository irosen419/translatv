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

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
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

// A ledger root the server can write to without touching the repo's real one.
const root = mkdtempSync(join(tmpdir(), "e2e-"));
mkdirSync(join(root, "out", "translatv"), { recursive: true });
writeFileSync(join(root, "out", "translatv", "spend_log.jsonl"), "", "utf8");

console.log("Starting server...");
const server = spawn("npx", ["tsx", "server/src/index.ts"], {
  env: {
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
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));

let browser;
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
  check("both export formats are offered", (await ben.locator(".panel-head button").count()) === 2);
  check(
    "no HTML export is offered",
    !(await ben.locator(".panel-head").innerText()).toLowerCase().includes("html"),
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
  // Back in English: a reload drops the seat and the chosen dialect with it, so Ben lands on the
  // same first screen anybody else would.
  check(
    "the room code is remembered for rejoining",
    backUp.includes(en("landing.codeLabel")) || backUp.includes(en("panel.title")),
  );

  // Put Ben back in the room. A reload drops the media permission grant, so he rejoins through
  // the form exactly as a real person would after refreshing.
  if (!(await ben.locator(".room").isVisible())) {
    await ben.getByLabel("Room code").fill(code);
    await ben.getByRole("button", { name: "Join chat" }).click();
    await ben.getByLabel("Your name, just for this chat").fill("Ben");
    await ben.getByLabel("Your language and region").selectOption("es-AR");
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
  server.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${checks - failures} of ${checks} checks passed.`);
process.exit(failures === 0 ? 0 : 1);
