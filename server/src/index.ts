// Server entry point.

import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describeConfig, loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { log } from "./log.js";
import { SpendGate } from "./spend/caps.js";
import { ephemeralDataRefusal, isEphemeralDataDir, openStore, type Store } from "./store/index.js";
import { flushView, isEphemeralLedger, ledgerWritable } from "./spend/ledger.js";
import { createAnthropicClient } from "./translate/anthropic.js";
import { TranslationService } from "./translate/TranslationService.js";
import { SignalingServer } from "./ws/server.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist/index.js sits two levels below the server workspace, which is one below the repo root.
const repoRoot = join(here, "..", "..");
const clientDist = join(repoRoot, "client", "dist");

// The belt behind the braces. Every async WebSocket handler now catches its own rejections, so
// nothing known reaches here, but Node 20's default for an unhandled rejection is to throw and
// exit the process. For a server holding live calls that is the worst available answer to an
// unexpected promise: every room on the box ends because one of them hit something nobody
// predicted. Logged loudly instead, so it is visible rather than absorbed, and the calls survive.
process.on("unhandledRejection", (reason) => {
  log.error("unhandled_rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    message:
      "a promise rejected with nothing to catch it. The process is being kept alive on purpose " +
      "so live calls are not dropped. This is a BUG: find the handler that let it escape.",
  });
});

const config = loadConfig(repoRoot);

const gate = new SpendGate(repoRoot, {
  dailyCapUsd: config.dailyCapUsd,
  roomCapUsd: config.roomCapUsd,
});

// Can the ledger actually be appended to, not merely read?
//
// The two are different questions and only the first was ever asked. The image copied the ledger
// in as root and then ran as node, so every append failed EACCES while the file stayed readable:
// the cap gate went on parsing a stale ledger and allowing calls, and spend continued untracked
// for the life of the container behind one warning line each. Refusing to translate is the same
// answer an unreadable ledger already gets, and for the same reason.
const writable = ledgerWritable(repoRoot);
if (!writable.ok) {
  log.error("boot", {
    message: "the spend ledger CANNOT be written, so translation is DISABLED.",
    reason: writable.reason,
  });
  log.error("boot", {
    message:
      "  The call, the transcript, and the original language subtitles all still work. " +
      "Fix the file's ownership or permissions and restart. In Docker this is COPY --chown.",
  });
}

// An ephemeral ledger silently re resets the day's spend on every restart, which re arms a cap
// that is supposed to be cumulative. Refuse in production rather than let that pass unnoticed.
if (config.isProduction && !writable.ok) {
  log.error("boot", { message: "refusing to start: production requires a writable ledger" });
  process.exit(1);
}
if (config.isProduction && isEphemeralLedger(repoRoot) && !process.env.ALLOW_EPHEMERAL_LEDGER) {
  log.error("boot", {
    message:
      "refusing to start: the spend ledger is on the image layer, not a mount, so a restart " +
      "would silently reset the day's spend and re arm the daily cap. Mount a volume over " +
      "out/, or set ALLOW_EPHEMERAL_LEDGER=1 if this host genuinely keeps it on the root device.",
  });
  process.exit(1);
}

// The database gets the same guard as the ledger, for a harsher reason: an image layer ledger
// resets a day's spend, an image layer database deletes every account on the next redeploy.
const dataRefusal = ephemeralDataRefusal({
  isProduction: config.isProduction,
  ephemeral: isEphemeralDataDir(config.dataDir),
  allow: process.env.ALLOW_EPHEMERAL_DATA,
});
if (dataRefusal !== null) {
  log.error("boot", { message: dataRefusal });
  process.exit(1);
}

// Without a password nobody can prove they are the admin, so the gate on starting a call is
// open to everyone. That is fine on a laptop and is the whole point of the feature in
// production, so a deployment that forgot the variable must not come up quietly serving an
// unguarded app. Same shape as the ledger guards above: refuse loudly, say what to set.
if (config.isProduction && config.adminPassword === null) {
  log.error("boot", {
    message:
      "refusing to start: ADMIN_PASSWORD is not set, so admin gating would be off and anyone " +
      "could start a call. Set ADMIN_PASSWORD in the environment.",
  });
  process.exit(1);
}

// Reported AFTER the guards, not before. It used to run first, so a process that was about to
// refuse to start announced "listening on port 8080" on its way out. The CI log showed exactly
// that sequence, which is a confusing thing to hand someone debugging a failed boot.
for (const line of describeConfig(config)) log.info("boot", { message: line });

// Opened after every guard, so a boot that is going to refuse never creates a database file on
// its way out. Nothing reads it yet: M3 adds the first tables. A store that cannot open (an
// unwritable directory, a schema newer than this code) stops the boot, since accounts will live
// here and a server that cannot reach them has nothing correct to serve.
let store: Store;
try {
  store = openStore({ path: config.databasePath });
} catch (error) {
  log.error("boot", {
    message: "refusing to start: the database could not be opened",
    reason: error instanceof Error ? error.message : "unknown",
  });
  process.exit(1);
}
log.info("boot", { message: "database open", schemaVersion: store.schemaVersion() });

const llm = writable.ok && config.anthropicApiKey ? createAnthropicClient(config.anthropicApiKey) : null;
const translation = new TranslationService(llm, gate, repoRoot);

// The spend view is rebuilt here, off the paid call path, and only when a row has landed since
// last time. Rendering it per append was tried and reverted: it reparses the whole ledger and
// rewrites the whole markdown synchronously, which froze the event loop for 133ms per sentence
// at 10k rows and got worse forever. A minute of staleness in a generated document costs nothing;
// an eighth of a second of frozen signaling costs every room on the server.
const VIEW_FLUSH_MS = 60_000;
const viewTimer = setInterval(() => flushView(repoRoot), VIEW_FLUSH_MS);
viewTimer.unref();

const app = createApp(config, clientDist, translation);
const server = createServer(app);
const signaling = new SignalingServer(server, config, translation);

server.listen(config.port, () => {
  // Report the port actually bound, not the one requested. With PORT=0 the OS picks one, and
  // logging the request would print 0 and leave a test harness with nothing to connect to.
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : config.port;
  log.info("listening", { port: bound, url: `http://localhost:${bound}` });
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    // Fail loudly rather than exiting silently. A half started server is worse than none: the
    // client connects to whatever else is on that port and the symptoms make no sense.
    log.error("port_in_use", {
      port: config.port,
      message: `Port ${config.port} is already in use. Stop the other process, or set PORT.`,
    });
  } else {
    log.error("listen_failed", { message: error.message });
  }
  process.exit(1);
});

// Closing checkpoints the WAL back into the main file, so a stopped server leaves one file rather
// than three. Guarded because both shutdown paths below can reach it.
function closeStore(): void {
  if (store.db.isOpen) store.close();
}

function shutdown(signal: string): void {
  log.info("shutdown", { signal, rooms: signaling.roomCount });
  // Last chance to leave the view agreeing with the ledger. This is what makes a local test run
  // end with a file that does not need regenerating by hand before committing.
  clearInterval(viewTimer);
  flushView(repoRoot);
  signaling.close();
  server.close(() => {
    closeStore();
    process.exit(0);
  });
  // Do not wait forever on a socket that will not close. Rooms are in memory and die with the
  // process anyway, so there is nothing to flush.
  setTimeout(() => {
    closeStore();
    process.exit(0);
  }, 3_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
