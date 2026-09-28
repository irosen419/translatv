#!/usr/bin/env node
// Where does the time actually go, from a spoken sentence to a rendered subtitle?
//
//   npm run latency
//
// This is the zero cost first step HANDOFF-APP.md section 4 names. The owner's research notes at
// docs/research/real-time-translation-architecture.md recommend benchmarking Claude Haiku against
// GPT-5 nano and Gemini 2.5 Flash, and their own section 3 warns that swapping the translation
// model alone probably will not move end to end latency much. Nothing in this repo has ever
// measured that, so the recommendation rests on an untested premise. Measuring first is free.
// Comparing providers is not, and a paid comparison aimed at the wrong stage is money spent to
// learn nothing.
//
// SPENDS NOTHING, and cannot. There is no Anthropic client here at all: the provider is either an
// injected fake or a local HTTP stub, and the server under measurement runs against an ISOLATED
// ledger in a temporary directory rather than the repo's own. See isolatedServerTree below for
// why that isolation has to be a copied tree rather than an environment variable.
//
// Three planes, because the pipeline has three regions with genuinely different observability and
// pretending otherwise is how a benchmark lies:
//
//   A  wire and render, measured from OUTSIDE the application. Two real Chromium contexts and the
//      real server, with the WebSocket wrapped by the harness rather than by the app, so no
//      production code carries timing overhead.
//   B  the translation stage, in process, against a fake client. This is the only way to see the
//      spend gate, the per room ordering queue, and the ledger write separately.
//   C  recognition, which cannot be measured here at all and is reported as unmeasured.
//
// The honesty rules live in latency_stats.mjs and are the spend ledger's, transposed to
// milliseconds: an unmeasured stage is null and never zero, a total with any stage missing is
// reported as a floor, and a span that contains other spans is diagnostic and never summed.

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { accountsEnv, signedInContext } from "./accounts.mjs";
import { chromiumLaunchOptions, chromiumSource } from "./chromium.mjs";
import { copyFor } from "./copy.mjs";
import { floorSummary, measured, percentile, renderTable, unmeasured } from "./latency_stats.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * How many lines Plane A measures, and how many it sends first and throws away.
 *
 * The warmup is not padding. The first translated line pays for the SDK opening its HTTP
 * connection and for everything on that path being JIT compiled, and it measured 200 ms against a
 * 5 ms median. Reporting that as the p90 of the pipeline would describe a cost that is paid once
 * per process as though it were paid once per sentence.
 *
 * Twelve measured, because nearest rank p90 over 8 samples IS the maximum, so a table with n=8
 * prints the same outlier in two columns and looks like corroboration.
 */
const LINES = 12;
const WARMUP_LINES = 2;
/** Gap between lines, so the limiter refills and one line's work cannot overlap the next. */
const LINE_GAP_MS = 900;
/** Ledger sizes for the spend gate sweep. The repo's own ledger is in the low hundreds today. */
const LEDGER_SIZES = [100, 1_000, 10_000, 50_000];
/** Lines fired at once into one room, to expose the per room ordering queue. */
const QUEUE_DEPTH = 6;
/** The delay the fake provider takes in the queue measurement. A plausible real round trip. */
const QUEUE_PROVIDER_MS = 300;

const cleanups = [];
function onCleanup(fn) {
  cleanups.push(fn);
}

function section(title) {
  console.log(`\n${title}`);
}

/** Iterations discarded before sampling, so first call JIT cost is not reported as latency. */
const WARMUP = 3;

function timeSync(fn, iterations) {
  const samples = [];
  for (let i = 0; i < iterations + WARMUP; i += 1) {
    const start = performance.now();
    fn(i);
    const elapsed = performance.now() - start;
    if (i >= WARMUP) samples.push(elapsed);
  }
  return samples;
}

async function timeAsync(fn, iterations) {
  const samples = [];
  for (let i = 0; i < iterations + WARMUP; i += 1) {
    const start = performance.now();
    await fn(i);
    const elapsed = performance.now() - start;
    if (i >= WARMUP) samples.push(elapsed);
  }
  return samples;
}

async function waitFor(fn, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${description}: ${JSON.stringify(last)?.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Plane B: inside the translation stage, in process, against a fake client
// ---------------------------------------------------------------------------

const { TranslationService } = await import(`${REPO}/server/src/translate/TranslationService.ts`);
const { SpendGate, roomHash } = await import(`${REPO}/server/src/spend/caps.ts`);
const { append, entry } = await import(`${REPO}/server/src/spend/ledger.ts`);

const NO_CAP = { dailyCapUsd: 1e9, roomCapUsd: 1e9, userDailyCapUsd: 1e9 };
// A host, so the gate does the per user filter a real runtime call does and the measurement
// includes it.
const HOST = "latencyHost00000000000";
const ROOM = roomHash("LATENCY1");

/** A ledger of a given length, in a temporary root. Never the repo's own. */
function seedLedger(rows) {
  const root = mkdtempSync(join(tmpdir(), "lat-ledger-"));
  onCleanup(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "out", "translatv"), { recursive: true });

  const lines = [];
  for (let i = 0; i < rows; i += 1) {
    lines.push(
      JSON.stringify(
        entry({
          program: "runtime-translation",
          kind: "translation",
          model: "claude-haiku-4-5",
          room: roomHash(`SEED${i % 32}`),
          inputTokens: 500,
          outputTokens: 30,
          capUsd: 1.5,
          note: "latency harness seed",
        }),
      ),
    );
  }
  // One write rather than `rows` appends. The append path is measured separately below; seeding
  // 50,000 rows through it would spend a minute proving something already measured.
  writeFileSync(
    join(root, "out", "translatv", "spend_log.jsonl"),
    lines.length > 0 ? `${lines.join("\n")}\n` : "",
    "utf8",
  );
  return root;
}

/** A provider that costs nothing and takes exactly as long as it is told to. */
function fakeClient(delayMs) {
  return {
    async complete() {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { text: "tenes tiempo manana", inputTokens: 520, outputTokens: 12 };
    },
  };
}

function translateRequest(index) {
  return {
    lineId: `L${index}`,
    text: "do you have time tomorrow",
    sourceDialect: "en-US",
    targetDialect: "es-AR",
    context: [],
    glossary: [],
    roomHash: ROOM,
    userId: HOST,
    kind: "translation",
  };
}

async function planeB() {
  section("Plane B: inside the translation stage (in process, fake provider, zero spend)");
  const rows = [];
  const diagnostics = [];

  // The gate reads the LEDGER FROM DISK on every paid call. The cache keys on size and mtime, but
  // TranslationService.record calls gate.invalidate() straight after every append, so the next
  // call always re-reads and re-parses the whole file. That is on the critical path of every
  // translated sentence and it grows for the life of the ledger, which is append only forever.
  const gateSamples = {};
  for (const size of LEDGER_SIZES) {
    const root = seedLedger(size);
    const gate = new SpendGate(root, NO_CAP);
    gateSamples[size] = timeSync(() => {
      gate.invalidate();
      gate.check(ROOM, HOST);
    }, 20);
    console.log(`  spend gate, ${size} rows: measured`);
  }

  // The representative ledger size for the critical path row. The repo's own is in the low
  // hundreds today, so 1,000 is a near future server rather than a worst case.
  const REPRESENTATIVE = 1_000;

  const appendRoot = seedLedger(REPRESENTATIVE);
  const appendSamples = timeSync(
    (i) =>
      append(
        entry({
          program: "runtime-translation",
          kind: "translation",
          model: "claude-haiku-4-5",
          room: ROOM,
          inputTokens: 520,
          outputTokens: 12,
          capUsd: 1.5,
          note: `append probe ${i}`,
        }),
        appendRoot,
      ),
    20,
  );
  console.log("  ledger append: measured");

  // One whole translate() against a zero delay provider. Contains the gate, the prompt build, the
  // fake call, and the ledger append, so it is diagnostic rather than summed.
  const wholeRoot = seedLedger(REPRESENTATIVE);
  const wholeService = new TranslationService(fakeClient(0), new SpendGate(wholeRoot, NO_CAP), wholeRoot);
  const wholeSamples = await timeAsync(async (i) => {
    const result = await wholeService.translate(translateRequest(i));
    if (!result.ok) throw new Error(`translate failed: ${result.message}`);
  }, 20);
  console.log("  whole translate() call: measured");

  // The per room ordering queue. translate() chains per room so a transcript cannot reorder
  // itself, which is correct and has never been priced. Fire QUEUE_DEPTH lines at one room at
  // once: line k cannot start until line k-1 has come back from the provider.
  const queueRoot = seedLedger(REPRESENTATIVE);
  const queueService = new TranslationService(
    fakeClient(QUEUE_PROVIDER_MS),
    new SpendGate(queueRoot, NO_CAP),
    queueRoot,
  );
  const queueStart = performance.now();
  const queueWaits = await Promise.all(
    Array.from({ length: QUEUE_DEPTH }, async (_unused, i) => {
      await queueService.translate(translateRequest(i));
      return performance.now() - queueStart;
    }),
  );
  console.log("  per room queue: measured");

  rows.push(
    measured(`spend gate check, cold, ${REPRESENTATIVE} row ledger`, gateSamples[REPRESENTATIVE], {
      note: "cold on every call, because record() invalidates the cache after each append",
    }),
    unmeasured(
      "provider round trip",
      "no API key, and measuring it costs money. This is the one unknown term: see vt-0005",
    ),
    measured("ledger append", appendSamples, { note: "synchronous single write" }),
  );

  diagnostics.push(
    measured("whole translate() call, zero delay provider", wholeSamples, {
      path: false,
      note: "contains the three rows above",
    }),
    ...LEDGER_SIZES.map((size) =>
      measured(`spend gate check at ${size} ledger rows`, gateSamples[size], {
        path: false,
        note: "cold",
      }),
    ),
    measured(
      `per room queue, last of ${QUEUE_DEPTH} lines at ${QUEUE_PROVIDER_MS} ms each`,
      [queueWaits[QUEUE_DEPTH - 1]],
      {
        path: false,
        // The whole ladder, because one number cannot show that the wait is cumulative. These are
        // completion times from a common start, not a distribution, which is why they live in a
        // note rather than being handed to summarize as samples.
        note: `ladder ${queueWaits.map((w) => Math.round(w)).join(", ")} ms`,
      },
    ),
  );

  return { rows, diagnostics, queueWaits, gateSamples };
}

// ---------------------------------------------------------------------------
// Plane A: wire and render, from outside the application
// ---------------------------------------------------------------------------

/**
 * A stub that speaks the Anthropic messages API and never leaves this machine.
 *
 * The Anthropic SDK reads ANTHROPIC_BASE_URL from the environment, so pointing the REAL production
 * translation path at this costs no code change and no money. That matters: it means Plane A
 * exercises the actual pipeline (spend gate, pending broadcast, SDK call, ledger append, result
 * broadcast, render) rather than the degraded no-key path, which never even reaches most of it.
 *
 * The delay is a knob, defaulting to zero, so what Plane A reports is OUR overhead with the
 * provider term removed rather than hidden inside it.
 */
/** The harness marker inside the request's utterance, or null. See the caller for why not a regex. */
function markerOf(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  const content = String(payload?.messages?.[0]?.content ?? "");
  const utterance = content.match(/<utterance>([\s\S]*?)<\/utterance>/);
  return utterance?.[1].match(/lp-\d{4}/)?.[0] ?? null;
}

function startStub(delayMs) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      // Read the marker out of the USER message's <utterance>, which is where buildUserMessage
      // puts the line being translated. Two things make the obvious shortcuts wrong:
      //
      //   The first marker anywhere in the body is the PREVIOUS line's. The user message carries
      //     recent conversation as context ahead of the utterance.
      //   Regexing the whole body for <utterance> matches inside the SYSTEM prompt, which names
      //     the tag in its own anti prompt injection instructions, so a lazy match runs from
      //     there through the context and lands on the wrong line.
      //
      // Parsing the JSON and reading messages[0].content confines the search to the one field
      // that holds the utterance. The marker only: the body carries real line text and none of
      // it is stored, logged, or written anywhere.
      const marker = markerOf(body);
      if (process.env["VT_STUB_DEBUG"]) console.error(`  stub request: marker=${marker}`);
      const send = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_stub",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [{ type: "text", text: marker ? `TR ${marker}` : "TR" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 520, output_tokens: 12 },
          }),
        );
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      onCleanup(() => server.close());
      resolve({ port: server.address().port, server });
    });
  });
}

/**
 * A copy of the server, with its own ledger, so measuring cannot write to the repo's.
 *
 * The ledger path is not configurable: server/src/index.ts derives repoRoot from the module's own
 * location (`join(here, "..", "..")`), so a server started from server/src writes to
 * out/translatv/spend_log.jsonl in THIS repository. With a stub provider answering every
 * call, that would append rows for money nobody spent, into an append only file that is the
 * project's source of truth for what it has cost. Copying the tree moves repoRoot with it.
 *
 * node_modules is symlinked rather than copied, and the copy is only of what repoRoot is computed
 * from plus what the server serves.
 */
function isolatedServerTree() {
  const root = mkdtempSync(join(tmpdir(), "lat-server-"));
  onCleanup(() => rmSync(root, { recursive: true, force: true }));

  cpSync(join(REPO, "server"), join(root, "server"), { recursive: true });
  cpSync(join(REPO, "client", "dist"), join(root, "client", "dist"), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");

  // The ledger has to EXIST: ledgerWritable refuses a missing one and the server then disables
  // translation, which is the very path this plane exists to avoid measuring.
  mkdirSync(join(root, "out", "translatv"), { recursive: true });
  writeFileSync(join(root, "out", "translatv", "spend_log.jsonl"), "", "utf8");
  return root;
}

/**
 * The probe, installed before any application script runs.
 *
 * Wraps window.WebSocket and watches the transcript. Entirely harness side:
 * client/src/net/socket.ts calls the bare global `new WebSocket(url, protocols)`, so subclassing
 * the global here (passing every argument through, the access token subprotocol included)
 * intercepts every frame without one line of production code knowing about it.
 *
 * It records a message TYPE, a lineId, and the harness's own marker token. Never the text of a
 * line, which is the same rule server/src/log.ts enforces on the server.
 */
function probe() {
  const timing = { frames: [], dom: [], socket: null };
  window.__vtTiming = timing;

  // performance.timeOrigin plus performance.now(), NOT Date.now(). These spans are single digit
  // milliseconds and Date.now() quantizes to 1 ms, so its resolution was comparable to the signal
  // being measured and a 1.4 ms span read as either 1 or 2. timeOrigin is wall clock, so stamps
  // from two browser contexts and from the harness are still on one timeline.
  const now = () => performance.timeOrigin + performance.now();

  function describe(raw) {
    const text = String(raw);
    const marker = text.match(/(TR )?lp-\d{4}/);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return { t: "unparsed", lineId: null, marker: null };
    }
    return {
      t: message.t ?? null,
      lineId: message.lineId ?? message.line?.lineId ?? null,
      marker: marker ? marker[0] : null,
    };
  }

  const Native = window.WebSocket;
  class TimedSocket extends Native {
    constructor(...args) {
      super(...args);
      timing.socket = this;
      this.addEventListener("message", (event) => {
        timing.frames.push({ dir: "in", at: now(), ...describe(event.data) });
      });
    }

    send(data) {
      timing.frames.push({ dir: "out", at: now(), ...describe(data) });
      return super.send(data);
    }
  }
  window.WebSocket = TimedSocket;

  // First sighting of each marker on screen. childList plus characterData, because React updating
  // a line in place changes a text node rather than replacing an element.
  const seen = new Set();
  function scan() {
    const el = document.querySelector(".transcript") ?? document.body;
    if (!el) return;
    const at = now();
    for (const match of (el.textContent || "").matchAll(/(TR )?lp-\d{4}/g)) {
      if (seen.has(match[0])) continue;
      seen.add(match[0]);
      timing.dom.push({ key: match[0], at });
    }
  }

  // Observe `document`, not `document.documentElement`. An init script runs before the page's own
  // scripts and there is no guarantee documentElement exists yet: reading it as null threw here,
  // which silently aborted the rest of this probe while leaving the socket wrapper above already
  // installed. The symptom was a full set of frames and an empty DOM timeline, which reads like a
  // rendering problem in the app rather than a bug in the harness.
  new MutationObserver(scan).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

// The join flow, matching script/e2e.mjs. The selectors live in one shape in both because they
// are the app's real labels, and a harness that invents its own drifts the moment the UI moves.
async function enterRoom(page, base, name, dialect, action) {
  await page.goto(base);
  if (action.kind === "create") {
    await page.getByRole("button", { name: "Start a new chat" }).click();
  } else {
    await page.getByLabel("Room code").fill(action.code);
    await page.getByRole("button", { name: "Join chat" }).click();
  }
  await page.getByLabel("Your name, just for this chat").fill(name);
  await page.getByLabel("Your language and region").selectOption(dialect);
  // Looked up in the chosen dialect: the form switches language the moment the picker moves, so
  // an English pattern here never matched Ben, who joins in Argentine Spanish.
  const submit = copyFor(dialect)(action.kind === "create" ? "prejoin.submit.create" : "prejoin.submit.join");
  await page.getByRole("button", { name: submit }).click();
}

async function pingRoundTrips(page, count) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    samples.push(
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            const socket = window.__vtTiming.socket;
            const start = performance.now();
            const onMessage = (event) => {
              try {
                if (JSON.parse(String(event.data)).t !== "pong") return;
              } catch {
                return;
              }
              socket.removeEventListener("message", onMessage);
              resolve(performance.now() - start);
            };
            socket.addEventListener("message", onMessage);
            socket.send(JSON.stringify({ t: "ping" }));
          }),
      ),
    );
    await new Promise((r) => setTimeout(r, 50));
  }
  return samples;
}

/** Frames of one type carrying one marker, in arrival order. */
function framesFor(timing, type, marker) {
  return timing.frames.filter((f) => f.t === type && f.marker === marker);
}

function domAt(timing, key) {
  return timing.dom.find((d) => d.key === key)?.at ?? null;
}

async function planeA(stubDelayMs) {
  section("Plane A: wire and render (two real browsers, the real server, a local stub provider)");

  const stub = await startStub(stubDelayMs);
  const root = isolatedServerTree();

  const serverLog = [];
  const server = spawn("npx", ["tsx", join(root, "server", "src", "index.ts")], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: "0",
      NODE_ENV: "development",
      // A value the stub never checks. It is here because a null key disables translation
      // outright, and the whole point of this plane is to measure the path that a key enables.
      ANTHROPIC_API_KEY: "stub-key-not-a-real-credential",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
      // The stub is on loopback. Letting an outbound proxy near it would measure the proxy.
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      NO_PROXY: "127.0.0.1,localhost",
      // Every call needs an account: open signup and a throwaway database (script/accounts.mjs).
      ...accountsEnv(root),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  onCleanup(() => server.kill("SIGKILL"));
  server.stdout.on("data", (d) => serverLog.push(String(d)));
  server.stderr.on("data", (d) => serverLog.push(String(d)));

  const port = await waitFor(() => {
    const match = serverLog.join("").match(/"event":"listening","port":(\d+)/);
    return match ? Number(match[1]) : null;
  }, "the server to report its port");
  const base = `http://localhost:${port}`;
  await waitFor(
    async () => await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false),
    "the server to answer /healthz",
  );

  const health = await fetch(`${base}/healthz`).then((r) => r.json());
  if (health.translation !== "enabled") {
    throw new Error(`the server did not enable translation: ${JSON.stringify(health)}`);
  }
  console.log(`  server up on ${port}, translation ${health.translation}, ledger isolated in ${root}`);

  console.log(`  chromium: ${chromiumSource()}`);
  const browser = await chromium.launch(chromiumLaunchOptions());
  onCleanup(() => browser.close());

  const contextA = await signedInContext(browser, base, "Ana", { permissions: ["microphone", "camera"] });
  const contextB = await signedInContext(browser, base, "Ben", { permissions: ["microphone", "camera"] });
  const ana = await contextA.newPage();
  const ben = await contextB.newPage();
  for (const page of [ana, ben]) {
    // Before addInitScript, so a probe that throws on injection is reported rather than leaving
    // a half installed probe and a timing table with a mysterious hole in it.
    page.on("pageerror", (error) => console.error(`  page error: ${error.message}`));
    await page.addInitScript(probe);
  }

  await enterRoom(ana, base, "Ana", "en-US", { kind: "create" });
  const code = await waitFor(async () => {
    const text = await ana.locator(".code-badge").textContent().catch(() => null);
    return text && text.trim().length === 8 ? text.trim() : null;
  }, "the room code to appear");

  await enterRoom(ben, base, "Ben", "es-AR", { kind: "join", code });
  await waitFor(async () => (await ben.locator(".room").isVisible()) || null, "Ben to enter the room");
  await waitFor(
    async () => ((await ana.locator("text=Ben").count()) > 0 ? true : null),
    "Ana to see Ben arrive",
  );
  console.log(`  both in room ${code}, Ana en-US and Ben es-AR`);

  const pings = await pingRoundTrips(ana, 20);

  const markers = [];
  for (let i = 1; i <= LINES + WARMUP_LINES; i += 1) {
    const marker = `lp-${String(i).padStart(4, "0")}`;
    // The first WARMUP_LINES are sent and rendered like any other, and then left out of the
    // sample set below rather than never sent: the pipeline has to actually do the work for the
    // connection and the code paths to be warm.
    if (i > WARMUP_LINES) markers.push(marker);
    await ana.getByPlaceholder("Type a message").fill(marker);
    await ana.getByPlaceholder("Type a message").press("Enter");
    try {
      await waitFor(
        () => ana.evaluate((m) => window.__vtTiming.dom.some((d) => d.key === `TR ${m}`), marker),
        `the translation of ${marker} to render`,
      );
    } catch (error) {
      // A timeout here means the pipeline did not do what this plane assumes. Say what the app
      // actually did rather than only that it did not finish: the frame types that arrived and
      // the server's own log are the two things that distinguish a stub that was never reached
      // from a selector that no longer matches.
      const frames = await ana.evaluate(() => window.__vtTiming.frames.map((f) => f.t));
      console.error(`  frames seen: ${[...new Set(frames)].join(", ")}`);
      const dom = await ana.evaluate(() => ({
        keys: window.__vtTiming.dom.map((d) => d.key),
        transcript: document.querySelector(".transcript") === null ? "ABSENT" : "present",
        markers: [
          ...(document.body.innerText || "").matchAll(/(TR )?lp-\d{4}/g),
        ].map((m) => m[0]),
      }));
      console.error(`  dom probe: ${JSON.stringify(dom)}`);
      console.error(`  server log tail: ${serverLog.join("").split("\n").slice(-6).join(" | ")}`);
      throw error;
    }
    await new Promise((r) => setTimeout(r, LINE_GAP_MS));
  }
  console.log(`  ${LINES + WARMUP_LINES} lines sent and translated, first ${WARMUP_LINES} discarded as warmup`);

  const anaTiming = await ana.evaluate(() => window.__vtTiming);
  const benTiming = await ben.evaluate(() => window.__vtTiming);

  const toServer = [];
  const translation = [];
  const renderUpdate = [];
  const renderInsert = [];
  const toPeer = [];
  const skipped = [];

  for (const marker of markers) {
    const sent = framesFor(anaTiming, "chat.send", marker)[0]?.at ?? null;
    const final = framesFor(anaTiming, "transcript.final", marker)[0]?.at ?? null;
    // translation.result carries the stub's text, so its marker is the TR form.
    const result = framesFor(anaTiming, "translation.result", `TR ${marker}`)[0]?.at ?? null;
    const insertAt = domAt(anaTiming, marker);
    const updateAt = domAt(anaTiming, `TR ${marker}`);
    const peerFinal = framesFor(benTiming, "transcript.final", marker)[0]?.at ?? null;

    if (sent === null || final === null || result === null || updateAt === null) {
      skipped.push(marker);
      continue;
    }
    toServer.push(final - sent);
    translation.push(result - final);
    renderUpdate.push(updateAt - result);
    if (insertAt !== null) renderInsert.push(insertAt - final);
    if (peerFinal !== null) toPeer.push(peerFinal - sent);
  }

  if (skipped.length > 0) {
    // Named rather than quietly dropped. A silently smaller sample set is how a table stops
    // describing the run it claims to describe.
    console.log(
      `  NOTE: ${skipped.length} of ${LINES} measured lines had an incomplete frame set: ${skipped.join(", ")}`,
    );
  }

  const rows = [
    unmeasured(
      "recognition, speech end to STT final",
      "no audio hardware in a container and the fake device emits a tone, not speech: see vt-0004",
    ),
    measured("send to the line coming back from the server", toServer, {
      note: "uplink, server ingest, broadcast, downlink",
    }),
    measured("line to translation result", translation, {
      // Best case on both counts: the provider is local and instant, and this server's ledger
      // starts empty, so the spend gate is at the cheapest point on the curve Plane B measures.
      note: `provider stubbed at ${stubDelayMs} ms, empty ledger, so this is our best case`,
    }),
    measured("result frame to the DOM showing it", renderUpdate, { note: "store, React, DOM" }),
  ];

  const diagnostics = [
    measured("socket round trip, ping to pong", pings, { path: false, note: "network floor" }),
    measured("send to the peer's copy of the line", toPeer, { path: false, note: "one way" }),
    measured("line frame to the DOM showing the original", renderInsert, {
      path: false,
      note: "the first render, before any translation",
    }),
  ];

  return { rows, diagnostics, pings, stubDelayMs, skipped };
}

// ---------------------------------------------------------------------------

let exitCode = 0;
try {
  const b = await planeB();
  const a = await planeA(Number(process.env["VT_STUB_DELAY_MS"] ?? 0));

  section("End to end, from speech to a rendered subtitle");
  console.log(renderTable([...a.rows, ...a.diagnostics]));

  section("Inside the translation stage");
  console.log(renderTable([...b.rows, ...b.diagnostics]));

  section("What this says about a provider A/B");

  // A stated ASSUMPTION, not a measurement, and labelled as one everywhere it is used. It exists
  // only to turn the measured overhead into a proportion. Replacing it with a real figure is what
  // vt-0005 and an armed eval step are for.
  const ASSUMED_PROVIDER_MS = 300;

  // percentile from latency_stats rather than a second implementation here. A verdict computed
  // with different arithmetic from the table it is summarising is a verdict that can disagree
  // with the numbers directly above it.
  const p50 = (samples) => percentile(samples, 50);
  const endToEnd = floorSummary(a.rows).knownMs;
  const gateGrowth = p50(b.gateSamples[50_000]) / p50(b.gateSamples[100]);
  const queueAmplification = b.queueWaits[QUEUE_DEPTH - 1] / b.queueWaits[0];
  const ourShare = (endToEnd / (endToEnd + ASSUMED_PROVIDER_MS)) * 100;

  console.log(
    [
      `  Everything this repository controls on the path from a sent line to a rendered`,
      `  translation measures ${endToEnd.toFixed(1)} ms. The provider round trip is the only unmeasured term`,
      `  on it. ASSUMING a ${ASSUMED_PROVIDER_MS} ms provider, which this run did not measure and cannot,`,
      `  our own overhead would be about ${ourShare.toFixed(0)} percent of that path.`,
      "",
      `  So section 3 of the research notes, that replacing the translation model alone will not`,
      `  move end to end latency much, does NOT hold for the translation path as this codebase is`,
      `  built today. There is almost nothing else on it. The notes may still be right OVERALL,`,
      `  because recognition is unmeasured and is the largest remaining candidate by far. vt-0004`,
      `  is the step that settles that, and it costs nothing either.`,
      "",
      `  Two findings that belong to us rather than to any provider, and that a model comparison`,
      `  would not have surfaced:`,
      "",
      `  1. The spend gate re-parses the WHOLE ledger on every paid call, synchronously. It is`,
      `     ${p50(b.gateSamples[100]).toFixed(2)} ms at 100 rows and ${p50(b.gateSamples[50_000]).toFixed(0)} ms at 50,000, about ${gateGrowth.toFixed(0)}x, and the ledger is`,
      `     append only so it only ever grows. Synchronous means the whole event loop, so past a`,
      `     few thousand rows this stalls every room on the process once per translated sentence.`,
      "",
      `  2. The per room ordering queue serializes. ${QUEUE_DEPTH} lines against a ${QUEUE_PROVIDER_MS} ms provider finished`,
      `     at ${b.queueWaits[QUEUE_DEPTH - 1].toFixed(0)} ms rather than ${QUEUE_PROVIDER_MS} ms, an amplification of ${queueAmplification.toFixed(1)}x. The ordering is`,
      `     correct and worth keeping, and it means provider latency is multiplied under fast`,
      `     speech rather than merely added. That is the strongest argument in this run for`,
      `     comparing providers on SPEED. It is not an argument for comparing them on price.`,
    ].join("\n"),
  );
} catch (error) {
  exitCode = 1;
  console.error(`\nFATAL: ${error?.stack ?? error}`);
} finally {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      // Cleanup is best effort. A temp directory that outlives the run is not worth failing over.
    }
  }
}

process.exit(exitCode);
