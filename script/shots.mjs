#!/usr/bin/env node
// Screenshot the room at a phone viewport and at a desktop one.
//
// A layout that only ever gets checked by reading its stylesheet is a layout nobody has seen. The
// mobile overlay in particular is a stack of absolutely positioned pieces over a video element,
// which is exactly the arrangement where a rule that reads correctly still lands wrong.
//
// This is a LOOKING tool, not a test. It asserts nothing and fails nothing. Run it when the room
// layout changes, look at what lands in out/shots, and delete them afterwards.
//
// Run with: node script/shots.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { accountsEnv, signedInContext } from "./accounts.mjs";
import { chromiumLaunchOptions } from "./chromium.mjs";
import { copyFor } from "./copy.mjs";

const OUT = "out/shots";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

async function waitFor(fn, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Promise.resolve so a synchronous probe (the port regex) works alongside an async one.
    const value = await Promise.resolve().then(fn).catch(() => null);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${description}`);
}

const root = mkdtempSync(join(tmpdir(), "shots-"));
mkdirSync(join(root, "out", "translatv"), { recursive: true });
writeFileSync(join(root, "out", "translatv", "spend_log.jsonl"), "", "utf8");
mkdirSync(OUT, { recursive: true });

const serverLog = [];
const server = spawn("npx", ["tsx", "server/src/index.ts"], {
  // Every call needs an account: open signup and a throwaway database (script/accounts.mjs).
  env: { ...process.env, PORT: "0", NODE_ENV: "development", ANTHROPIC_API_KEY: "", ...accountsEnv(root) },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));

let browser;
try {
  const port = await waitFor(() => {
    const m = serverLog.join("").match(/"event":"listening","port":(\d+)/);
    return m ? Number(m[1]) : null;
  }, "the server to report its port");
  const base = `http://localhost:${port}`;
  await waitFor(() => fetch(`${base}/healthz`).then((r) => r.ok), "the server to answer");

  browser = await chromium.launch(chromiumLaunchOptions());

  /** Put one page through create or join, into the room. */
  async function enter(page, { create, name, dialect, code }) {
    // The form is in English until the dialect picker moves, and in the chosen language from
    // that moment on, so the submit button has to be looked up AFTER the selection. This is the
    // same sequence a person goes through, and the reason these shots are worth taking: the
    // layouts below are holding Spanish, which runs about a quarter longer than English.
    const copy = copyFor(dialect);
    await page.goto(base);
    if (create) {
      await page.getByRole("button", { name: "Start a new chat" }).click();
    } else {
      await page.getByLabel("Room code").fill(code);
      await page.getByRole("button", { name: "Join chat" }).click();
    }
    await page.getByLabel("Your name, just for this chat").fill(name);
    await page.getByLabel("Your language and region").selectOption(dialect);
    await page
      .getByRole("button", {
        name: create ? copy("prejoin.submit.create") : copy("prejoin.submit.join"),
      })
      .click();
    await waitFor(() => page.locator(".room").isVisible(), `${name} to enter the room`);
    console.log(`  ${name} is in the room`);
  }

  console.log(`server up on ${base}, browser launched`);

  for (const [label, viewport] of [["phone", PHONE], ["desktop", DESKTOP]]) {
    console.log(`--- ${label}`);
    // One account per person per pass: an email can only sign up once.
    const ctxA = await signedInContext(browser, base, `Ana-${label}`, {
      viewport,
      permissions: ["microphone", "camera"],
    });
    const ctxB = await signedInContext(browser, base, `Ben-${label}`, {
      viewport: DESKTOP,
      permissions: ["microphone", "camera"],
    });
    const ana = await ctxA.newPage();
    const ben = await ctxB.newPage();

    // Ana reads Argentine Spanish. The English layouts are the ones that have always been
    // looked at; these shots exist to see the longer language in the same furniture.
    await enter(ana, { create: true, name: "Ana", dialect: "es-AR" });
    const anaCopy = copyFor("es-AR");
    const code = await waitFor(
      async () => (await ana.locator(".code-badge").textContent())?.trim() || null,
      "a room code",
    );
    // Alone in the room, before anyone joins. This is the state that has to carry the code.
    await ana.screenshot({ path: `${OUT}/${label}-alone.png` });

    await enter(ben, { create: false, name: "Ben", dialect: "en-US", code });
    const benCopy = copyFor("en-US");

    // Enough conversation that the overlay has scrollback above the current line, which is the
    // part that cannot be judged from an empty room.
    for (const [who, text] of [
      [ana, "hey, are you free tomorrow"],
      [ben, "si, despues de las tres"],
      [ana, "perfect, let us say four"],
      [ben, "dale, nos vemos entonces"],
    ]) {
      const placeholder = (who === ana ? anaCopy : benCopy)("composer.placeholder");
      await who.getByPlaceholder(placeholder).fill(text);
      await who.getByPlaceholder(placeholder).press("Enter");
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 600));

    await ana.screenshot({ path: `${OUT}/${label}-room.png` });
    await ana.getByRole("button", { name: anaCopy("room.settings.title") }).click();
    await new Promise((r) => setTimeout(r, 500));
    await ana.screenshot({ path: `${OUT}/${label}-drawer.png` });

    console.log(`wrote ${OUT}/${label}-room.png and ${OUT}/${label}-drawer.png`);
    await ctxA.close();
    await ctxB.close();
  }
} catch (error) {
  // The finally below exits 0 unconditionally, so without this a failure here produced a silent
  // run that wrote no files and reported nothing at all, which is the least useful possible
  // outcome for a tool whose entire job is to show you something.
  console.error(`\nshots failed: ${error?.message ?? error}`);
  console.error(serverLog.join("").slice(-1500));
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  // Explicit, because npx leaves the tsx child holding a pipe and node will not exit while that
  // handle is open. Without this the script finishes its work and then hangs indefinitely.
  process.exit(0);
}
