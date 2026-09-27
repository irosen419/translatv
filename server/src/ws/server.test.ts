// Integration tests over REAL WebSockets against a real HTTP server.
//
// The RoomManager unit tests prove the state machine. These prove the wiring: that a message
// arriving on one socket reaches the right other socket, that close codes carry the meaning the
// client depends on, and that the protocol validation actually rejects what it claims to.

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CLOSE, WS_PATH, type ServerMessage } from "@translatv/shared";
import { GRACE_MS } from "../rooms/RoomManager.js";
import type { Config } from "../config.js";
import { roomHash, SpendGate } from "../spend/caps.js";
import { MAX_CONNECTIONS_PER_IP } from "../security/rateLimit.js";
import { TranslationService, type LlmClient } from "../translate/TranslationService.js";
import { mintAdminToken } from "../security/adminAuth.js";
import { clientAddress, SignalingServer } from "./server.js";

let server: Server;
let signaling: SignalingServer;
let port: number;
let root: string;

const ORIGIN = "http://localhost:5173";

function config(): Config {
  return {
    port: 0,
    repoRoot: root,
    allowedOrigins: [ORIGIN],
    anthropicApiKey: "test",
    dailyCapUsd: 10,
    roomCapUsd: 1.5,
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    // No admin password: these suites exercise the room lifecycle, not the gate, and with no
    // password configured the gate is off. The gate has its own suite that sets one.
    adminPassword: null,
    isProduction: false,
    trustProxy: false,
  };
}

// Counts its calls, because "no API call happened" is the actual requirement of the skip path
// and every other signal for it is indirect. Without the counter a test can only assert that no
// failure was reported, which a broken skip would also satisfy.
const echoClient: LlmClient & { calls: number } = {
  calls: 0,
  async complete({ user }) {
    echoClient.calls += 1;
    const match = user.match(/<utterance>(.*)<\/utterance>/s);
    return { text: `ES:${match?.[1] ?? ""}`, inputTokens: 100, outputTokens: 10 };
  },
};

/** A socket wrapper that queues messages so a test can await the next one of a type. */
class Client {
  readonly received: ServerMessage[] = [];
  private readonly waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  closeCode: number | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.received.push(message);
      const index = this.waiters.findIndex((w) => w.match(message));
      if (index !== -1) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(message);
      }
    });
    socket.on("close", (code) => {
      this.closeCode = code;
    });
  }

  static async connect(origin = ORIGIN): Promise<Client> {
    // WS_PATH, not a bare origin. This helper used to omit it, which is part of why a client
    // that also omitted it looked fine here: both sides agreed on the wrong thing, and the
    // server accepted any path anyway.
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { headers: { origin } });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new Client(socket);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  next<T extends ServerMessage["t"]>(type: T, timeoutMs = 2_000): Promise<Extract<ServerMessage, { t: T }>> {
    const existing = this.received.find((m) => m.t === type);
    if (existing) return Promise.resolve(existing as Extract<ServerMessage, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${type}; got ${this.received.map((m) => m.t).join(", ")}`)),
        timeoutMs,
      );
      this.waiters.push({
        match: (m) => m.t === type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { t: T }>);
        },
      });
    });
  }

  async closed(timeoutMs = 2_000): Promise<number> {
    if (this.closeCode !== null) return this.closeCode;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not close")), timeoutMs);
      this.socket.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function createRoom(client: Client, username = "Ana", dialect = "en-US") {
  client.send({ t: "room.create", username, dialect, wantsVideo: false });
  return client.next("room.created");
}

beforeEach(async () => {
  echoClient.calls = 0;
  root = mkdtempSync(join(tmpdir(), "ws-"));
  mkdirSync(join(root, "out", "translatv"), { recursive: true });
  writeFileSync(join(root, "out", "translatv", "spend_log.jsonl"), "", "utf8");

  const cfg = config();
  const gate = new SpendGate(root, { dailyCapUsd: cfg.dailyCapUsd, roomCapUsd: cfg.roomCapUsd });
  const translation = new TranslationService(echoClient, gate, root);

  server = createServer();
  signaling = new SignalingServer(server, cfg, translation);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  signaling.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("the upgrade path", () => {
  // This suite exists because of a bug that no test could see. The server accepted a WebSocket
  // upgrade on ANY path, and the client built its URL without one. Served from a single origin,
  // which is what the end to end run does, that works. Behind the dev proxy, which forwards only
  // the contracted prefix, the socket reached the dev server instead of this one and died with
  // nothing logged on either side: the create simply vanished.
  //
  // Pinning the path is what makes the two modes fail identically instead of one of them lying.
  it("refuses an upgrade on the wrong path rather than quietly accepting it", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { origin: ORIGIN } });

    const outcome = await new Promise<string>((resolve) => {
      socket.once("open", () => resolve("accepted"));
      socket.once("error", () => resolve("refused"));
    });
    socket.close();

    expect(outcome).toBe("refused");
  });

  it("accepts the contracted path", async () => {
    // The other half. A pin that refused everything would pass the test above and break the app.
    const client = await Client.connect();

    expect(client).toBeDefined();
    client.close();
  });
});

describe("room lifecycle over the wire", () => {
  it("creates a room and returns a shareable code", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana);
    expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(created.polite).toBe(false); // the creator is impolite
    ana.close();
  });

  it("lets a second person join and tells both about each other", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana);

    const ben = await Client.connect();
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "es-AR" });

    const joined = await ben.next("room.joined");
    expect(joined.peer?.username).toBe("Ana");
    expect(joined.polite).toBe(true);

    const announced = await ana.next("peer.joined");
    expect(announced.peer.username).toBe("Ben");

    ana.close();
    ben.close();
  });

  it("refuses a third person", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana);
    const ben = await Client.connect();
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "es-AR" });
    await ben.next("room.joined");

    const cam = await Client.connect();
    cam.send({ t: "room.join", code: created.code, username: "Cam", dialect: "en-US" });
    const error = await cam.next("error");
    expect(error.code).toBe("ROOM_FULL");
    expect(error.fatal).toBe(true);

    ana.close();
    ben.close();
    cam.close();
  });

  it("frees the seat on an explicit leave and lets someone new take it", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana);
    const ben = await Client.connect();
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "es-AR" });
    await ben.next("room.joined");

    ben.send({ t: "room.leave" });
    const left = await ana.next("peer.left");
    expect(left.reason).toBe("left");

    const cam = await Client.connect();
    cam.send({ t: "room.join", code: created.code, username: "Cam", dialect: "es-MX" });
    const joined = await cam.next("room.joined");
    expect(joined.peer?.username).toBe("Ana");

    ana.close();
    cam.close();
  });

  it("ends the room for everyone with the close code the client acts on", async () => {
    // 4000 must be distinguishable from an ordinary drop: it tells the client NOT to try to
    // resume, and to freeze the transcript and offer a download instead.
    const ana = await Client.connect();
    const created = await createRoom(ana);
    const ben = await Client.connect();
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "es-AR" });
    await ben.next("room.joined");

    ana.send({ t: "room.end" });

    const ended = await ben.next("room.ended");
    expect(ended.byUsername).toBe("Ana");
    expect(await ben.closed()).toBe(CLOSE.roomEnded);

    const cam = await Client.connect();
    cam.send({ t: "room.join", code: created.code, username: "Cam", dialect: "en-US" });
    const error = await cam.next("error");
    expect(error.code).toBe("ROOM_ENDED");
    cam.close();
  });

  it("restores a seat and the transcript on resume", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana);
    ana.send({ t: "stt.final", text: "hello there", seq: 1 });
    await ana.next("transcript.final");

    ana.close();
    await new Promise((r) => setTimeout(r, 50));

    const again = await Client.connect();
    again.send({ t: "room.resume", code: created.code, resumeToken: created.resumeToken });
    const joined = await again.next("room.joined");
    expect(joined.snapshot.lines).toHaveLength(1);
    expect(joined.snapshot.lines[0]?.text).toBe("hello there");
    again.close();
  });

  it("REFUSES a bad resume token rather than seating a new member", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana);
    ana.close();
    await new Promise((r) => setTimeout(r, 50));

    const attacker = await Client.connect();
    attacker.send({ t: "room.resume", code: created.code, resumeToken: "guessed" });
    const error = await attacker.next("error");
    expect(error.code).toBe("INVALID_RESUME");
    attacker.close();
  });
});

describe("signaling relay", () => {
  it("relays an offer to the peer and nobody else", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana);
    const ben = await Client.connect();
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "es-AR" });
    await ben.next("room.joined");

    ana.send({ t: "rtc.offer", sdp: "v=0 fake offer" });
    const relayed = await ben.next("rtc.offer");
    expect(relayed.sdp).toBe("v=0 fake offer");
    expect(relayed.from).toBe(created.selfId);

    // The sender must not receive its own offer back.
    expect(ana.received.some((m) => m.t === "rtc.offer")).toBe(false);

    ana.close();
    ben.close();
  });
});

describe("transcripts and translation", () => {
  it("sends the ORIGINAL immediately and the translation after", async () => {
    // The decoupling that means a translation failure never costs the user the original line.
    const ana = await Client.connect();
    const created = await createRoom(ana, "Ana", "en-US");
    const ben = await Client.connect();
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "es-AR" });
    await ben.next("room.joined");

    ana.send({ t: "stt.final", text: "do you have time", seq: 1 });

    const original = await ben.next("transcript.final");
    expect(original.line.text).toBe("do you have time");
    expect(original.line.translated).toBeNull();

    const translated = await ben.next("translation.result");
    expect(translated.lineId).toBe(original.line.lineId);
    expect(translated.text).toBe("ES:do you have time");

    ana.close();
    ben.close();
  });

  it("relays interim results without storing or translating them", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana);
    const ben = await Client.connect();
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "es-AR" });
    await ben.next("room.joined");

    ana.send({ t: "stt.interim", text: "do you have", seq: 1 });
    const interim = await ben.next("transcript.interim");
    expect(interim.text).toBe("do you have");

    // An interim must never produce a transcript line: it is the live original text, not a
    // committed one, and storing it would double every sentence in the scrollback.
    await new Promise((r) => setTimeout(r, 100));
    expect(ben.received.some((m) => m.t === "transcript.final")).toBe(false);

    ana.close();
    ben.close();
  });

  it("applies a correction immediately and puts it in the glossary", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana, "Ana", "en-US");
    const ben = await Client.connect();
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "es-AR" });
    await ben.next("room.joined");

    ana.send({ t: "stt.final", text: "the standup", seq: 1 });
    const line = await ana.next("transcript.final");
    await ana.next("translation.result");

    ben.send({
      t: "glossary.correct",
      lineId: line.line.lineId,
      correctedTranslation: "la daily",
    });

    const glossary = await ben.next("glossary.updated");
    expect(glossary.entries[0]?.target).toBe("la daily");

    ana.close();
    ben.close();
  });

  it("routes chat through the same pipeline as speech", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana, "Ana", "en-US");
    const ben = await Client.connect();
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "es-AR" });
    await ben.next("room.joined");

    ana.send({ t: "chat.send", text: "typed message" });
    const line = await ben.next("transcript.final");
    expect(line.line.source).toBe("chat");
    const translated = await ben.next("translation.result");
    expect(translated.text).toBe("ES:typed message");

    ana.close();
    ben.close();
  });
});

describe("protocol validation", () => {
  it("rejects a malformed frame without dropping the connection", async () => {
    const ana = await Client.connect();
    ana.socket.send("this is not JSON");
    const error = await ana.next("error");
    expect(error.code).toBe("MALFORMED");
    expect(ana.socket.readyState).toBe(WebSocket.OPEN);
    ana.close();
  });

  it("rejects an unknown message type", async () => {
    const ana = await Client.connect();
    ana.send({ t: "room.destroy_everything" });
    const error = await ana.next("error");
    expect(error.code).toBe("MALFORMED");
    ana.close();
  });

  it("rejects an unknown dialect", async () => {
    const ana = await Client.connect();
    ana.send({ t: "room.create", username: "Ana", dialect: "xx-YY", wantsVideo: false });
    const error = await ana.next("error");
    expect(error.code).toBe("MALFORMED");
    ana.close();
  });

  it("strips control and format characters from a username", async () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE lets a username visually impersonate another user's name.
    const ana = await Client.connect();
    ana.send({
      t: "room.create",
      username: "An‮a ",
      dialect: "en-US",
      wantsVideo: false,
    });
    const created = await ana.next("room.created");
    expect(created.you.username).toBe("Ana");
    ana.close();
  });

  it("rejects an empty username", async () => {
    const ana = await Client.connect();
    ana.send({ t: "room.create", username: "   ", dialect: "en-US", wantsVideo: false });
    const error = await ana.next("error");
    expect(error.code).toBe("MALFORMED");
    ana.close();
  });

  it("refuses a transcript from a connection that is not in a room", async () => {
    const ana = await Client.connect();
    ana.send({ t: "stt.final", text: "hello", seq: 1 });
    const error = await ana.next("error");
    expect(error.code).toBe("NOT_IN_ROOM");
    ana.close();
  });
});

describe("origin check", () => {
  it("refuses an upgrade from a disallowed origin", async () => {
    // The CSRF equivalent for a cookie-less WebSocket app.
    await expect(Client.connect("http://evil.example")).rejects.toThrow();
  });

  // Testing a phone against a laptop is the only way to reach the acoustic echo question, and it
  // means loading the app from the laptop's LAN address over https. That origin is not localhost,
  // so without this it is refused and the call fails at the socket with a bare 403.
  //
  // Safe to relax only because a browser sets Origin itself. A malicious page still arrives as
  // its own origin and is still refused; the only thing this admits is a page genuinely served
  // from a private address, which on a dev machine is this app.
  it("allows a private LAN origin in development, so a phone on the same wifi can connect", async () => {
    const client = await Client.connect("https://192.168.1.5:5173");
    expect(client).toBeDefined();
    client.close();

    const tenDot = await Client.connect("http://10.0.0.7:5173");
    expect(tenDot).toBeDefined();
    tenDot.close();
  });

  it("does not mistake a public address that merely looks private", async () => {
    // 172.16.0.0/12 is private; 172.32.x.x is NOT, and a sloppy prefix match on "172." would
    // wave it through. Same for a hostname that just starts with the digits.
    await expect(Client.connect("http://172.32.0.1:5173")).rejects.toThrow();
    await expect(Client.connect("http://192.168.1.5.evil.example")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Not translating: the paths that must cost nothing.
//
// Every test here asserts echoClient.calls, because the requirement is about money rather than
// about what the screen says. A skip that still called the model would satisfy every other
// assertion in this file.

/** Give the server a beat to do something wrong, for the assertions that a thing NEVER arrives. */
async function settle(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pair(anaDialect: string, benDialect: string) {
  const ana = await Client.connect();
  const created = await createRoom(ana, "Ana", anaDialect);
  const ben = await Client.connect();
  ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: benDialect });
  await ben.next("room.joined");
  await ana.next("peer.joined");
  return { ana, ben, code: created.code };
}

describe("lines that need no translation", () => {
  it("is born skipped, with no pending frame and no API call", async () => {
    const { ana, ben } = await pair("en-US", "en-GB");

    ana.send({ t: "stt.final", text: "do you have time tomorrow", seq: 1 });
    const line = await ben.next("transcript.final");

    expect(line.line.translationStatus).toBe("skipped");
    await settle();
    expect(ben.received.some((m) => m.t === "translation.pending")).toBe(false);
    expect(ben.received.some((m) => m.t === "translation.result")).toBe(false);
    expect(echoClient.calls).toBe(0);

    ana.close();
    ben.close();
  });

  it("does not consume a translation rate limit token", async () => {
    // The burst is 10. Sending 12 same language lines would exhaust it if each one took a token,
    // and the proof that none did is not the absence of a failure here: it is that a genuine
    // translation still works afterwards. Without that second half this test would also pass on
    // a server that simply never rate limits.
    const { ana, ben } = await pair("en-US", "en-GB");

    for (let i = 0; i < 12; i += 1) {
      ana.send({ t: "stt.final", text: `line ${i}`, seq: i + 1 });
    }
    await settle(400);
    expect(ben.received.some((m) => m.t === "translation.failed")).toBe(false);
    expect(echoClient.calls).toBe(0);

    ben.send({ t: "member.update", dialect: "es-AR" });
    await ana.next("peer.updated");
    ana.send({ t: "stt.final", text: "now translate this", seq: 99 });

    await ben.next("translation.pending");
    const result = await ben.next("translation.result");
    expect(result.origin).toBe("model");
    expect(echoClient.calls).toBe(1);

    ana.close();
    ben.close();
  });

  it("is not refused when the room spend cap is already breached", async () => {
    // A line that costs nothing must not be told there is no budget for it. This used to fail:
    // the same language check sat AFTER the spend gate, so a monolingual room started showing
    // "not translated" errors once the cap was hit, for lines that never needed a call.
    const { ana, ben, code } = await pair("en-US", "en-GB");

    writeFileSync(
      join(root, "out", "translatv", "spend_log.jsonl"),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        program: "translatv",
        model: "claude-haiku-4-5",
        room: roomHash(code),
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 99,
      })}\n`,
      "utf8",
    );

    ana.send({ t: "stt.final", text: "still fine", seq: 1 });
    const line = await ben.next("transcript.final");

    expect(line.line.translationStatus).toBe("skipped");
    await settle();
    expect(ben.received.some((m) => m.t === "translation.failed")).toBe(false);

    ana.close();
    ben.close();
  });

  it("says nothing to translate rather than unavailable when no key is configured", async () => {
    // Ordering matters: the skip has to come before the "translation is not configured" guard.
    // Otherwise a monolingual room on a keyless server reports a failure for lines it was never
    // going to translate, and the client latches translation off over it.
    const keyless = createServer();
    const gate = new SpendGate(root, { dailyCapUsd: 10, roomCapUsd: 1.5 });
    const offline = new SignalingServer(keyless, config(), new TranslationService(null, gate, root));
    await new Promise<void>((resolve) => keyless.listen(0, "127.0.0.1", resolve));

    // Client.connect reads the module level port, so point it at the keyless server for the
    // duration of this test and put it back afterwards.
    const realPort = port;
    port = (keyless.address() as { port: number }).port;

    const ana = await Client.connect();
    const created = await createRoom(ana, "Ana", "en-US");
    const ben = await Client.connect();
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "en-GB" });
    await ben.next("room.joined");

    ana.send({ t: "stt.final", text: "hello", seq: 1 });
    const line = await ben.next("transcript.final");
    expect(line.line.translationStatus).toBe("skipped");
    await settle();
    expect(ben.received.some((m) => m.t === "translation.failed")).toBe(false);

    ana.close();
    ben.close();
    port = realPort;
    offline.close();
    await new Promise<void>((resolve) => keyless.close(() => resolve()));
  });

  it("carries WHY it was skipped on the line itself, with no second frame", async () => {
    // The reason used to exist only on the retry path's translation.skipped frame, so a line born
    // skipped arrived carrying no reason at all and three different situations rendered
    // identically: the same words, large, with nothing to tell them apart.
    const { ana, ben } = await pair("en-US", "en-GB");

    ana.send({ t: "stt.final", text: "same language here", seq: 1 });
    const line = await ben.next("transcript.final");

    expect(line.line.translationStatus).toBe("skipped");
    expect(line.line.skipReason).toBe("same_language");
    await settle();
    expect(ben.received.some((m) => m.t === "translation.skipped")).toBe(false);
    expect(echoClient.calls).toBe(0);

    ana.close();
    ben.close();
  });

  it("carries recipient_off on a line the reader opted out of", async () => {
    const { ana, ben } = await pair("en-US", "es-AR");

    ben.send({ t: "member.update", wantsTranslation: false });
    await ana.next("peer.updated");
    ana.send({ t: "stt.final", text: "hello there", seq: 1 });
    const line = await ana.next("transcript.final");

    expect(line.line.translationStatus).toBe("skipped");
    expect(line.line.skipReason).toBe("recipient_off");
    expect(echoClient.calls).toBe(0);

    ana.close();
    ben.close();
  });

  it("carries no_peer for someone alone in the room", async () => {
    const ana = await Client.connect();
    await createRoom(ana, "Ana", "en-US");

    ana.send({ t: "stt.final", text: "anybody there", seq: 1 });
    const line = await ana.next("transcript.final");

    expect(line.line.skipReason).toBe("no_peer");

    ana.close();
  });

  it("leaves a translated line with no skip reason at all", async () => {
    const { ana, ben } = await pair("en-US", "es-AR");

    ana.send({ t: "stt.final", text: "translate me", seq: 1 });
    const line = await ben.next("transcript.final");

    expect(line.line.translationStatus).toBe("pending");
    expect(line.line.skipReason).toBeNull();

    ana.close();
    ben.close();
  });

  it("skips for a speaker alone in the room", async () => {
    const ana = await Client.connect();
    await createRoom(ana, "Ana", "en-US");

    ana.send({ t: "stt.final", text: "talking to myself", seq: 1 });
    const line = await ana.next("transcript.final");

    expect(line.line.translationStatus).toBe("skipped");
    await settle();
    expect(ana.received.some((m) => m.t === "translation.pending")).toBe(false);
    expect(echoClient.calls).toBe(0);

    ana.close();
  });

  it("still translates a genuine cross language line", async () => {
    const { ana, ben } = await pair("en-US", "es-AR");

    ana.send({ t: "stt.final", text: "do you have time tomorrow", seq: 1 });
    const line = await ben.next("transcript.final");
    expect(line.line.translationStatus).toBe("pending");

    await ben.next("translation.pending");
    const result = await ben.next("translation.result");
    expect(result.origin).toBe("model");
    expect(result.text).toContain("ES:");
    expect(echoClient.calls).toBe(1);

    ana.close();
    ben.close();
  });
});

describe("turning translation off", () => {
  it("stops translating FOR the person who turned it off, and only for them", async () => {
    // "Neither person can override the other" is a claim about non interference, so both halves
    // have to be proven in one test. Asserting only that Ana's side went quiet would also pass on
    // an implementation that disabled translation for the whole room.
    const { ana, ben } = await pair("en-US", "es-AR");

    ana.send({ t: "member.update", wantsTranslation: false });
    await ben.next("peer.updated");

    // Ben speaks. Ana is the one who would read it, and she does not want it.
    ben.send({ t: "stt.final", text: "tenes tiempo manana", seq: 1 });
    const benLine = await ana.next("transcript.final");
    expect(benLine.line.translationStatus).toBe("skipped");
    await settle();
    expect(echoClient.calls).toBe(0);

    // Ana speaks. Ben still wants translations, so this one costs a call.
    ana.send({ t: "stt.final", text: "yes I do", seq: 2 });
    await ben.next("translation.pending");
    const result = await ben.next("translation.result");
    expect(result.text).toContain("ES:");
    expect(echoClient.calls).toBe(1);

    ana.close();
    ben.close();
  });

  it("takes effect again when turned back on", async () => {
    const { ana, ben } = await pair("en-US", "es-AR");

    ana.send({ t: "member.update", wantsTranslation: false });
    await ben.next("peer.updated");
    ana.send({ t: "member.update", wantsTranslation: true });
    await ben.next("peer.updated");

    ben.send({ t: "stt.final", text: "hola", seq: 1 });
    await ana.next("translation.pending");
    const result = await ana.next("translation.result");
    expect(result.text).toContain("ES:");

    ana.close();
    ben.close();
  });

  it("does not retro-untranslate a line that was already translated", async () => {
    const { ana, ben } = await pair("en-US", "es-AR");

    ana.send({ t: "stt.final", text: "already done", seq: 1 });
    const result = await ben.next("translation.result");
    const before = echoClient.calls;

    ben.send({ t: "member.update", wantsTranslation: false });
    await ana.next("peer.updated");
    await settle();

    const forSameLine = ben.received.filter(
      (m) => m.t === "translation.skipped" && m.lineId === result.lineId,
    );
    expect(forSameLine).toHaveLength(0);
    expect(echoClient.calls).toBe(before);

    ana.close();
    ben.close();
  });
});

describe("media state reaches the peer", () => {
  it("broadcasts a mute without disturbing anything else", async () => {
    const { ana, ben } = await pair("en-US", "es-AR");

    ana.send({ t: "member.update", micEnabled: false });
    const update = await ben.next("peer.updated");

    expect(update.micEnabled).toBe(false);
    expect(update.username).toBeUndefined();
    expect(update.dialect).toBeUndefined();

    ana.close();
    ben.close();
  });

  it("shows a later joiner the state that is already true", async () => {
    // The argument for putting these on Member rather than in a side channel: someone arriving
    // after you muted has never seen the update that muted you.
    const ana = await Client.connect();
    const created = await createRoom(ana, "Ana", "en-US");
    ana.send({ t: "member.update", micEnabled: false, cameraEnabled: true });
    await settle(100);

    const ben = await Client.connect();
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "es-AR" });
    const joined = await ben.next("room.joined");

    expect(joined.peer?.micEnabled).toBe(false);
    expect(joined.peer?.cameraEnabled).toBe(true);
    expect(joined.you.wantsTranslation).toBe(true);

    ana.close();
    ben.close();
  });

  it("survives a resume", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana, "Ana", "en-US");
    ana.send({ t: "member.update", micEnabled: false, wantsTranslation: false });
    await settle(100);
    ana.close();

    const back = await Client.connect();
    back.send({ t: "room.resume", code: created.code, resumeToken: created.resumeToken });
    const joined = await back.next("room.joined");

    expect(joined.you.micEnabled).toBe(false);
    expect(joined.you.wantsTranslation).toBe(false);

    back.close();
  });
});

describe("retrying a line that needs no translation", () => {
  it("reports it as skipped rather than spending, and says why", async () => {
    const { ana, ben } = await pair("en-US", "en-GB");

    ana.send({ t: "stt.final", text: "same language", seq: 1 });
    const line = await ben.next("transcript.final");

    ben.send({ t: "translation.retry", lineId: line.line.lineId });
    const skipped = await ben.next("translation.skipped");

    expect(skipped.reason).toBe("same_language");
    expect(skipped.lineId).toBe(line.line.lineId);
    expect(echoClient.calls).toBe(0);

    ana.close();
    ben.close();
  });

  it("reports recipient_off when the reader turned translation off", async () => {
    const { ana, ben } = await pair("en-US", "es-AR");

    ana.send({ t: "member.update", wantsTranslation: false });
    await ben.next("peer.updated");
    ben.send({ t: "stt.final", text: "hola", seq: 1 });
    const line = await ana.next("transcript.final");

    ana.send({ t: "translation.retry", lineId: line.line.lineId });
    const skipped = await ana.next("translation.skipped");

    expect(skipped.reason).toBe("recipient_off");
    expect(echoClient.calls).toBe(0);

    ana.close();
    ben.close();
  });
});

describe("a resume that evicts a live socket", () => {
  // The evicted socket's close event arrives a moment AFTER the seat has been handed over, and
  // onClose used to call rooms.disconnect unconditionally. So the member who had just been
  // seated on the new socket was marked disconnected, given a 60 second reconnect deadline
  // against a healthy connection, and released by the sweep a minute later. The user's socket
  // stayed open, so the client never reconnected, while handleFinal, handleRetry, peerSocket and
  // broadcast could no longer find their member: every message silently dropped, with no error.
  // Alone in a room, the room itself was destroyed with someone sitting in it.
  //
  // Two ordinary ways in. Duplicating a tab (Chrome and Firefox copy sessionStorage, so the copy
  // resumes into a room whose first tab is still open), and the app's own reconnect racing the
  // server on a half open TCP connection, which is precisely the case the grace window is for.
  it("does not report the reclaimed seat as reconnecting when the old socket closes", async () => {
    const ana = await Client.connect();
    const created = await createRoom(ana, "Ana", "en-US");
    const cam = await Client.connect();
    cam.send({ t: "room.join", code: created.code, username: "Cam", dialect: "es-AR" });
    await cam.next("room.joined");

    const duplicate = await Client.connect();
    duplicate.send({ t: "room.resume", code: created.code, resumeToken: created.resumeToken });
    await duplicate.next("room.joined");
    expect(await ana.closed()).toBe(CLOSE.duplicateResume);

    // Long enough for the evicted socket's close to have been processed. The assertion is about
    // something that must NEVER arrive, so it needs the wait to mean anything.
    await settle(400);

    const reconnecting = cam.received.filter(
      (m) => m.t === "peer.state" && m.peerId === created.selfId && m.connection === "reconnecting",
    );
    expect(reconnecting).toHaveLength(0);
    // And the seat is still genuinely held rather than merely quiet about it.
    expect(signaling.roomCount).toBe(1);

    duplicate.close();
    cam.close();
  });

  it("stops the superseded socket acting on the room it just handed over", async () => {
    // close() starts a handshake, it does not stop delivery: ws dispatches every frame that
    // arrives before the peer's close reply. The evicted Connection still carried roomCode and
    // memberId in that window, so it could still run room.end, room.leave, member.update or
    // chat.send against a room that now belongs to somebody else.
    //
    // pause() is what makes the window observable instead of a race. A paused client never reads
    // the server's close frame and so never answers it, which holds the connection in exactly
    // the state a half open TCP socket produces on its own.
    const ana = await Client.connect();
    const created = await createRoom(ana, "Ana", "en-US");
    const cam = await Client.connect();
    cam.send({ t: "room.join", code: created.code, username: "Cam", dialect: "es-AR" });
    await cam.next("room.joined");

    ana.socket.pause();

    const duplicate = await Client.connect();
    duplicate.send({ t: "room.resume", code: created.code, resumeToken: created.resumeToken });
    await duplicate.next("room.joined");

    ana.send({ t: "room.end" });
    await settle(400);

    // Read first, tear down second. A paused socket never answers the server's close handshake,
    // so leaving it open past a failed assertion hangs the afterEach instead of reporting the
    // failure.
    const endedForCam = cam.received.some((m) => m.t === "room.ended");
    const endedForDuplicate = duplicate.received.some((m) => m.t === "room.ended");
    const rooms = signaling.roomCount;
    ana.socket.terminate();
    duplicate.close();
    cam.close();

    expect(endedForCam).toBe(false);
    expect(endedForDuplicate).toBe(false);
    expect(rooms).toBe(1);
  });
});

describe("a connection that is already in a room", () => {
  // bind() overwrote roomCode and memberId with no guard, so a second create orphaned the first
  // membership with connected: true. onClose only unbinds the current one, so the abandoned room
  // never armed its destroy deadline and was never swept. Five rooms a minute, four of them
  // abandonable per connection, forever.
  it("cannot create a second room", async () => {
    const ana = await Client.connect();
    await createRoom(ana);
    expect(signaling.roomCount).toBe(1);

    ana.send({ t: "room.create", username: "Ana", dialect: "en-US", wantsVideo: false });
    const error = await ana.next("error");

    expect(error.code).toBe("ALREADY_IN_ROOM");
    expect(error.fatal).toBe(false);
    expect(signaling.roomCount).toBe(1);
    ana.close();
  });

  it("cannot join a second room", async () => {
    const ana = await Client.connect();
    const ben = await Client.connect();
    const first = await createRoom(ana);
    const second = await createRoom(ben, "Ben", "es-AR");

    ana.send({ t: "room.join", code: second.code, username: "Ana", dialect: "en-US", wantsVideo: false });
    const error = await ana.next("error");

    expect(error.code).toBe("ALREADY_IN_ROOM");
    // Both rooms still exist and Ana is still in her own, rather than silently moved.
    expect(signaling.roomCount).toBe(2);
    expect(first.code).not.toBe(second.code);
    ana.close();
    ben.close();
  });
});

describe("the per connection message limit", () => {
  it("is not shared between two people behind one address", async () => {
    // It was keyed on connection.ip while documenting itself as per connection, so two users on
    // one NAT split a single 120 token burst and a breach closed whichever socket happened to
    // send the frame that tripped it.
    const heavy = await Client.connect();
    const quiet = await Client.connect();

    for (let i = 0; i < 200; i += 1) heavy.send({ t: "ping" });

    // The loud connection is the one that pays.
    expect(await heavy.closed()).toBe(CLOSE.rateLimitAbuse);

    // The quiet one, on the same 127.0.0.1, still has its OWN full burst. The number matters:
    // one message would prove nothing, because the shared bucket refills at 60 a second and a
    // single token is back almost immediately. 100 is more than any plausible refill across the
    // close round trip, and comfortably inside a per connection burst of 120.
    for (let i = 0; i < 100; i += 1) quiet.send({ t: "ping" });
    const created = await createRoom(quiet, "Quiet", "en-US");
    expect(created.code).toHaveLength(8);
    quiet.close();
  });
});

describe("connections per address", () => {
  // createPerIp and joinPerIp only apply once a socket is up, and the frame limiter is keyed on
  // the connection so a reconnect buys a fresh burst. Nothing bounded establishment itself, so
  // one address could hold open as many sockets as it liked and pay a per connection budget for
  // each. This closes the door the other two limiters are behind.
  it("refuses more than the cap from one address", async () => {
    const held = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i += 1) held.push(await Client.connect());

    // Every one of those is still usable: the cap refuses the excess, it does not punish the set.
    const room = await createRoom(held[0], "First", "en-US");
    expect(room.code).toHaveLength(8);

    await expect(Client.connect()).rejects.toThrow();

    for (const client of held) client.close();
  });

  it("frees a slot when a connection closes", async () => {
    const held = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i += 1) held.push(await Client.connect());

    held[0].close();
    await settle(150);

    // The cap counts CONCURRENT connections. A closed one must give its slot back, or a busy
    // server would refuse everyone forever after enough churn.
    const replacement = await Client.connect();
    expect(replacement.socket.readyState).toBe(WebSocket.OPEN);

    replacement.close();
    for (const client of held.slice(1)) client.close();
  });
});

describe("the liveness heartbeat", () => {
  // Connection.alive was declared, initialised true, and set true again by the pong listener,
  // and then never read: there was no socket.ping() and no liveness interval anywhere in
  // server/src. The client's own 20 second {t:"ping"} is an APPLICATION message, so it keeps the
  // connection warm from the client's side and tells the server nothing about a client that has
  // gone away. A half open socket therefore kept its room seat and one of the twelve per address
  // connection slots until TCP gave up, which can be many minutes.
  it("terminates a socket that stopped answering", async () => {
    const zombie = await Client.connect();
    // A paused socket never reads the ping frame, so it never sends the automatic pong. The
    // protocol level reply cannot be switched off, and pausing produces exactly what the server
    // sees from a half open TCP connection: a socket that looks open and answers nothing.
    zombie.socket.pause();

    signaling.pingRound(); // records it as unanswered, then pings
    await settle(100);
    signaling.pingRound(); // still unanswered, so it goes

    zombie.socket.resume();
    // 1006, not a close code of ours: terminate() sends no close frame, deliberately. A socket
    // that will not answer a ping will not answer a close handshake either.
    expect(await zombie.closed()).toBe(1006);
  });

  it("leaves a socket that answers alone", async () => {
    // The other half, and the reason it has to be here: a reaper that terminated unconditionally
    // would satisfy the test above and disconnect every healthy person on the server every
    // thirty seconds.
    const healthy = await Client.connect();
    const created = await createRoom(healthy, "Ana", "en-US");

    signaling.pingRound();
    await settle(150); // long enough for the pong to have come back
    signaling.pingRound();
    await settle(150);

    expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
    expect(healthy.closeCode).toBeNull();
    // And the seat is still theirs, which is the thing the reaper must not cost anyone.
    expect(created.code).toHaveLength(8);
    expect(signaling.roomCount).toBe(1);
    healthy.close();
  });
});

describe("an async handler that rejects", () => {
  // dispatch is wrapped in try/catch, but the three async handlers are launched with `void`, so
  // their rejections never reach it. Node 20 throws on an unhandled rejection and the process
  // exits, and there is no process level handler anywhere.
  //
  // The reachable throw is SpendGate.check, which rethrows anything that is not LedgerNotFound.
  // records() converts a failing statSync into LedgerNotFound, but load() then calls
  // readFileSync, which throws EISDIR or EACCES for a ledger that exists, stats fine, and still
  // cannot be read. That propagates out of check, execute, translate, runTranslation,
  // handleFinal, and into the void.
  it("logs the rejection instead of taking the process down", async () => {
    const brokenRoot = mkdtempSync(join(tmpdir(), "ws-broken-"));
    // A DIRECTORY where the ledger file belongs. statSync succeeds, so the gate does not report
    // LedgerNotFound and take its own refusal path, and readFileSync then throws EISDIR out of
    // check() exactly as an unreadable file would.
    mkdirSync(join(brokenRoot, "out", "translatv", "spend_log.jsonl"), {
      recursive: true,
    });

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    const broken = createServer();
    const gate = new SpendGate(brokenRoot, { dailyCapUsd: 10, roomCapUsd: 1.5 });
    const service = new TranslationService(echoClient, gate, brokenRoot);
    const brokenSignaling = new SignalingServer(broken, config(), service);
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));

    const realPort = port;
    port = (broken.address() as { port: number }).port;
    try {
      const ana = await Client.connect();
      const created = await createRoom(ana, "Ana", "en-US");
      const ben = await Client.connect();
      ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "es-AR" });
      await ben.next("room.joined");

      ana.send({ t: "stt.final", text: "hello", seq: 1 });
      // The original still reaches the peer. Only the translation is in question, and it must
      // cost neither the line nor the process.
      const line = await ben.next("transcript.final");
      await settle(300);
      expect(rejections).toEqual([]);

      // All three `void` sites, not just the first. chat.send reaches the gate through
      // handleFinal like stt.final does, and translation.retry through handleRetry.
      ana.send({ t: "chat.send", text: "typed message" });
      await settle(300);
      expect(rejections).toEqual([]);

      ben.send({ t: "translation.retry", lineId: line.line.lineId });
      await settle(300);
      expect(rejections).toEqual([]);

      expect(ana.socket.readyState).toBe(WebSocket.OPEN);
      ana.close();
      ben.close();
    } finally {
      port = realPort;
      process.off("unhandledRejection", onRejection);
      brokenSignaling.close();
      await new Promise<void>((resolve) => broken.close(() => resolve()));
      rmSync(brokenRoot, { recursive: true, force: true });
    }
  });
});

describe("clientAddress", () => {
  const headers = { "x-forwarded-for": "203.0.113.7, 70.41.3.18" };

  it("ignores the forwarded header when the proxy is not trusted", () => {
    // The default, and it has to be. Trusting an attacker controlled header with nothing in
    // front means a fresh value per request walks past every per IP limit, the room code brute
    // force guard included.
    expect(clientAddress(headers, "10.0.0.5", false)).toBe("10.0.0.5");
  });

  it("takes the NEAREST hop when the proxy IS trusted, not the leftmost", () => {
    // The rightmost entry is the one OUR proxy appended, so it is the only one we have any
    // reason to believe. Everything to its left was supplied by whoever called the proxy and
    // can say anything at all.
    expect(clientAddress(headers, "10.0.0.5", true)).toBe("70.41.3.18");
  });

  // The attack this shape exists to stop. Security review demonstrated it against the login
  // endpoint: twelve wrong passwords with a rotating X-Forwarded-For all returned 401 and never
  // once a 429, because every request looked like a brand new client. The rate limiter on the
  // one password protecting the app was a no op, and online guessing was unmetered.
  it("cannot be walked past by a client that prepends its own hops", () => {
    const spoofed = { "x-forwarded-for": "10.9.9.1, 203.0.113.7, 70.41.3.18" };
    const again = { "x-forwarded-for": "10.9.9.2, 203.0.113.7, 70.41.3.18" };
    expect(clientAddress(spoofed, "10.0.0.5", true)).toBe("70.41.3.18");
    // Two requests from one attacker must land in ONE bucket however they dress the header up.
    expect(clientAddress(spoofed, "10.0.0.5", true)).toBe(
      clientAddress(again, "10.0.0.5", true),
    );
  });

  // The other direction, which the same bug enabled: pinning someone ELSE's address to burn
  // through their login attempts and lock them out.
  //
  // The header is written the way it ACTUALLY arrives: the attacker's claim, then the address
  // our own proxy appended. Their claim can only ever sit to the LEFT of their real address.
  //
  // There is deliberately no rule here rejecting a header that arrives with only ONE entry. A
  // single entry is the ordinary, honest case: nginx's $proxy_add_x_forwarded_for emits exactly
  // one for a client that sent none, and a proxy configured to overwrite emits exactly one
  // always. Refusing it would drop every honest client back to remoteAddress, which is the
  // proxy, collapsing the entire internet into one rate limit bucket.
  //
  // It would also buy nothing. Hop count is not an authenticity signal: against a pass through
  // proxy an attacker simply sends two entries and owns the rightmost one too. What defends
  // this is the proxy overwriting or appending, not anything countable from here.
  it("cannot be used to pin a victim's address", () => {
    const framing = { "x-forwarded-for": "198.51.100.77, 70.41.3.18" };
    expect(clientAddress(framing, "10.0.0.5", true)).toBe("70.41.3.18");
  });

  it("joins a repeated header before taking the nearest hop", () => {
    // A header sent twice arrives as an array, and the LAST value holds the nearest hop. Taking
    // element zero here would reintroduce the same bypass through a different door.
    expect(
      clientAddress({ "x-forwarded-for": ["10.9.9.1, 203.0.113.7", "70.41.3.18"] }, "10.0.0.5", true),
    ).toBe("70.41.3.18");
  });

  it("falls back to the socket address when trusted but no header arrives", () => {
    expect(clientAddress({}, "10.0.0.5", true)).toBe("10.0.0.5");
  });

  it("handles the header arriving as an array", () => {
    expect(clientAddress({ "x-forwarded-for": ["198.51.100.4"] }, "10.0.0.5", true)).toBe(
      "198.51.100.4",
    );
  });

  it("says unknown rather than crashing when there is no address at all", () => {
    expect(clientAddress({}, undefined, false)).toBe("unknown");
  });
});


// Everything above runs with the gate OFF, which is the app as it behaved before any of this
// existed. This suite is the gate itself, so it stands up its own server with a password set.
// Its own server, not a reconfigured shared one, because half these tests turn on what happens
// to a room AFTER someone leaves it, and that is not a state worth sharing between cases.
describe("the admin gate", () => {
  // Generated, not written down. See the note in adminAuth.test.ts: a password shaped literal
  // reads as a committed credential to a scanner and to a person skimming the file.
  const PASSWORD = randomBytes(24).toString("hex");
  let gatedServer: Server;
  let gatedSignaling: SignalingServer;
  let gatedPort: number;
  let gatedRoot: string;

  function token(): string {
    return mintAdminToken(PASSWORD, Date.now());
  }

  /** Client.connect reads the shared `port`; this suite has its own server. */
  async function gatedConnect(): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${gatedPort}${WS_PATH}`, {
      headers: { origin: ORIGIN },
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new Client(socket);
  }

  beforeEach(async () => {
    gatedRoot = mkdtempSync(join(tmpdir(), "ws-gated-"));
    mkdirSync(join(gatedRoot, "out", "translatv"), { recursive: true });
    writeFileSync(join(gatedRoot, "out", "translatv", "spend_log.jsonl"), "", "utf8");

    const cfg = { ...config(), repoRoot: gatedRoot, adminPassword: PASSWORD };
    const gate = new SpendGate(gatedRoot, { dailyCapUsd: cfg.dailyCapUsd, roomCapUsd: cfg.roomCapUsd });
    gatedServer = createServer();
    gatedSignaling = new SignalingServer(
      gatedServer,
      cfg,
      new TranslationService(echoClient, gate, gatedRoot),
    );
    await new Promise<void>((resolve) => gatedServer.listen(0, "127.0.0.1", resolve));
    gatedPort = (gatedServer.address() as { port: number }).port;
  });

  afterEach(async () => {
    gatedSignaling.close();
    await new Promise<void>((resolve) => gatedServer.close(() => resolve()));
    rmSync(gatedRoot, { recursive: true, force: true });
  });

  describe("starting a call", () => {
    it("refuses someone with no token at all", async () => {
      const ana = await gatedConnect();
      ana.send({ t: "room.create", username: "Ana", dialect: "en-US", wantsVideo: false });
      expect((await ana.next("error")).code).toBe("ADMIN_REQUIRED");
      ana.close();
    });

    it("refuses a token that was not signed with this password", async () => {
      // The shape of a real token, signed by someone else. This is the forgery that matters:
      // anything that merely looks wrong would be caught by parsing.
      const ana = await gatedConnect();
      ana.send({
        t: "room.create",
        username: "Ana",
        dialect: "en-US",
        wantsVideo: false,
        adminToken: mintAdminToken("a different password", Date.now()),
      });
      expect((await ana.next("error")).code).toBe("ADMIN_REQUIRED");
      ana.close();
    });

    it("lets the admin through and marks them admin on the wire", async () => {
      const ana = await gatedConnect();
      ana.send({
        t: "room.create",
        username: "Ana",
        dialect: "en-US",
        wantsVideo: false,
        adminToken: token(),
      });
      const created = await ana.next("room.created");
      expect(created.you.isAdmin).toBe(true);
      ana.close();
    });
  });

  describe("joining a call", () => {
    async function adminCreates() {
      const ana = await gatedConnect();
      ana.send({
        t: "room.create",
        username: "Ana",
        dialect: "en-US",
        wantsVideo: false,
        adminToken: token(),
      });
      return { ana, code: (await ana.next("room.created")).code };
    }

    it("lets a guest in while the admin is sitting there", async () => {
      const { ana, code } = await adminCreates();
      const ben = await gatedConnect();
      ben.send({ t: "room.join", code, username: "Ben", dialect: "es-AR" });
      const joined = await ben.next("room.joined");
      // The guest is a guest, and knows it. The admin flag is the server's answer about what
      // was proved, never an echo of what the client asked for.
      expect(joined.you.isAdmin).toBe(false);
      expect(joined.peer?.isAdmin).toBe(true);
      ana.close();
      ben.close();
    });

    it("refuses a guest once the admin has gone", async () => {
      const { ana, code } = await adminCreates();
      ana.send({ t: "room.leave" });
      await ana.closed();

      const ben = await gatedConnect();
      ben.send({ t: "room.join", code, username: "Ben", dialect: "es-AR" });
      expect((await ben.next("error")).code).toBe("ADMIN_NOT_PRESENT");
      ben.close();
    });

    it("refuses a guest for a room that never existed, revealing nothing either way", async () => {
      // Same refusal as a real room with no admin in it. A code guesser learns only that they
      // are not the admin, which they already knew.
      const ben = await gatedConnect();
      ben.send({ t: "room.join", code: "ZZZZZZZZ", username: "Ben", dialect: "es-AR" });
      expect((await ben.next("error")).code).toBe("ADMIN_NOT_PRESENT");
      ben.close();
    });

    it("lets the admin rejoin their own room, which has no admin in it at that moment", async () => {
      // The gap the guest rule would close over if it were written as "the room must contain an
      // admin" without the "or you are one" half. The owner coming back to their own room must
      // not be locked out of it.
      const { ana, code } = await adminCreates();
      ana.send({ t: "room.leave" });
      await ana.closed();

      const again = await gatedConnect();
      again.send({ t: "room.join", code, username: "Ana", dialect: "en-US", adminToken: token() });
      // The room was ended by the admin leaving, so this is ROOM_ENDED rather than a seat. The
      // point is the refusal is about the ROOM being gone, not about who is asking.
      expect((await again.next("error")).code).toBe("ROOM_ENDED");
      again.close();
    });
  });

  describe("the admin dropping rather than leaving", () => {
    async function adminAndGuest() {
      const ana = await gatedConnect();
      ana.send({
        t: "room.create",
        username: "Ana",
        dialect: "en-US",
        wantsVideo: false,
        adminToken: token(),
      });
      const code = (await ana.next("room.created")).code;
      const ben = await gatedConnect();
      ben.send({ t: "room.join", code, username: "Ben", dialect: "es-AR" });
      await ben.next("room.joined");
      await ana.next("peer.joined");
      return { ana, ben, code };
    }

    it("counts a RECONNECTING admin as present, so a guest can still arrive mid blip", async () => {
      // A dropped socket is not a departure: the seat is held for the grace window. Someone
      // arriving during a thirty second wifi hop must not be turned away from a call that is
      // still very much happening.
      //
      // Ben is here to make the drop OBSERVABLE. Waiting a fixed number of milliseconds for the
      // server to notice would let this pass on a slow runner without having tested anything:
      // an admin the server still thinks is CONNECTED is trivially present, so the assertion
      // would hold for the wrong reason. Ben is told the instant the state actually changes.
      const { ana, ben, code } = await adminAndGuest();
      ana.socket.terminate();
      const state = await ben.next("peer.state");
      expect(state.connection).toBe("reconnecting");

      // Free the seat so someone new can try for it. Ben is a guest, so this ends nothing.
      ben.send({ t: "room.leave" });
      await ben.closed();

      const cal = await gatedConnect();
      cal.send({ t: "room.join", code, username: "Cal", dialect: "es-AR" });
      expect((await cal.next("room.joined")).code).toBe(code);
      cal.close();
    });

    it("ends the room once the admin's grace window actually expires", async () => {
      // The other end of the same rule, and the one that had no test at all: mutating this path
      // off passed the whole suite. Driven through sweepAt rather than by waiting, because the
      // grace window is a minute.
      const { ana, ben, code } = await adminAndGuest();
      ana.socket.terminate();
      // The server telling Ben is the signal that it has processed the drop. Sweeping before it
      // has would expire nothing and the test would hang rather than fail.
      expect((await ben.next("peer.state")).connection).toBe("reconnecting");

      gatedSignaling.sweepAt(Date.now() + GRACE_MS + 1_000);

      const ended = await ben.next("room.ended");
      expect(ended.byUsername).toBe("Ana");
      expect(await ben.closed()).toBe(CLOSE.roomEnded);

      // And the room is genuinely gone rather than left as a husk nobody can enter. This is the
      // shape of the bug review found: hasAdminPresent used to sweep and swallow the release,
      // so the expiry was consumed, endRoom never ran, and the guest sat in a room that could
      // not end and that nobody could join.
      const late = await gatedConnect();
      late.send({ t: "room.join", code, username: "Cal", dialect: "es-AR", adminToken: token() });
      expect((await late.next("error")).code).toBe("ROOM_ENDED");
      late.close();
    });

    it("does not end the room when a GUEST's grace window expires", async () => {
      const { ana, ben, code } = await adminAndGuest();
      ben.socket.terminate();
      expect((await ana.next("peer.state")).connection).toBe("reconnecting");

      gatedSignaling.sweepAt(Date.now() + GRACE_MS + 1_000);

      const left = await ana.next("peer.left");
      expect(left.reason).toBe("timeout");
      expect(ana.received.some((m) => m.t === "room.ended")).toBe(false);

      // The seat is free and the admin is still there, so a new guest can take it.
      const cal = await gatedConnect();
      cal.send({ t: "room.join", code, username: "Cal", dialect: "es-AR" });
      expect((await cal.next("room.joined")).code).toBe(code);
      cal.close();
      ana.close();
    });
  });

  describe("the admin leaving", () => {
    it("ends the call for the guest rather than leaving them in an empty room", async () => {
      const ana = await gatedConnect();
      ana.send({
        t: "room.create",
        username: "Ana",
        dialect: "en-US",
        wantsVideo: false,
        adminToken: token(),
      });
      const code = (await ana.next("room.created")).code;

      const ben = await gatedConnect();
      ben.send({ t: "room.join", code, username: "Ben", dialect: "es-AR" });
      await ben.next("room.joined");

      ana.send({ t: "room.leave" });

      const ended = await ben.next("room.ended");
      expect(ended.byUsername).toBe("Ana");
      expect(await ben.closed()).toBe(CLOSE.roomEnded);
    });

    it("does not end the call when a GUEST leaves", async () => {
      // The rule is about the admin specifically. A guest leaving frees a seat, exactly as it
      // always did, and the admin stays in their room.
      const ana = await gatedConnect();
      ana.send({
        t: "room.create",
        username: "Ana",
        dialect: "en-US",
        wantsVideo: false,
        adminToken: token(),
      });
      const code = (await ana.next("room.created")).code;

      const ben = await gatedConnect();
      ben.send({ t: "room.join", code, username: "Ben", dialect: "es-AR" });
      await ben.next("room.joined");
      await ana.next("peer.joined");

      ben.send({ t: "room.leave" });
      const left = await ana.next("peer.left");
      expect(left.reason).toBe("left");
      expect(ana.received.some((m) => m.t === "room.ended")).toBe(false);
      ana.close();
    });
  });
});
