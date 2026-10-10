// A person's saved terms are PRIVATE (owner decision, 2026-10-10). They shape the translations
// their owner reads, and never reach the other person's browser.
//
// Why: a saved term's phrase comes from someone else's line (decision C1). Broadcast with the room
// glossary, it went to every later caller: review measured a phrase Ana said in one call reaching
// Carla, who was never in it. So the stored glossary no longer joins the shared room glossary; it
// joins the prompt, for translations into its owner's dialect only.
//
// Real sockets, a real in memory store, and a capturing stub in place of the provider: no key,
// nothing spent, and the ledger is a temporary file.

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { WS_PATH, type AuthSession, type GlossaryEntry, type ServerMessage } from "@translatv/shared";
import { AuthService } from "../auth/service.js";
import type { Config } from "../config.js";
import { createApp } from "../http.js";
import { SpendGate } from "../spend/caps.js";
import { openStore, type Store } from "../store/index.js";
import { TranslationService, type LlmClient } from "../translate/TranslationService.js";
import { SignalingServer } from "../ws/server.js";
import { AccountService } from "./service.js";

const ORIGIN = "http://localhost:5173";
const PASSWORD = randomBytes(12).toString("hex");

/** Every prompt the stub was asked, and the target dialect each asked for, in order. */
const prompts: string[] = [];
const stub: LlmClient = {
  async complete({ system, user }) {
    prompts.push(`${system}\n${user}`);
    return { text: "translated", inputTokens: 10, outputTokens: 2 };
  },
};

let root: string;
let store: Store;
let auth: AuthService;
let account: AccountService;
let server: Server;
let signaling: SignalingServer;
let port: number;

beforeEach(async () => {
  prompts.length = 0;
  root = mkdtempSync(join(tmpdir(), "saved-terms-"));
  mkdirSync(join(root, "out", "translatv"), { recursive: true });
  writeFileSync(join(root, "out", "translatv", "spend_log.jsonl"), "", "utf8");
  store = openStore({ path: ":memory:" });
  auth = new AuthService(store, { secret: randomBytes(32).toString("hex"), signupMode: "open", ownerEmail: null });
  account = new AccountService(store);
  const cfg: Config = {
    port: 0,
    repoRoot: root,
    allowedOrigins: [ORIGIN],
    anthropicApiKey: null,
    authSecret: null,
    signupMode: "open",
    ownerEmail: null,
    dailyCapUsd: 10,
    roomCapUsd: 1.5,
    iceServers: [],
    isProduction: false,
    trustProxy: false,
    dataDir: root,
    databasePath: ":memory:",
  };
  const translation = new TranslationService(stub, new SpendGate(root, { dailyCapUsd: 10, roomCapUsd: 1.5 }), root);
  server = createServer(createApp(cfg, join(root, "no-dist"), translation, auth, account));
  signaling = new SignalingServer(server, cfg, translation, auth, account);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  signaling.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function signup(name: string): Promise<AuthSession> {
  const result = await auth.signup(
    { email: `${name.toLowerCase()}@example.test`, password: PASSWORD, displayName: name },
    Date.now(),
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

class Client {
  readonly received: ServerMessage[] = [];
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => this.received.push(JSON.parse(data.toString()) as ServerMessage));
  }

  static async connect(session: AuthSession): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
      headers: { origin: ORIGIN, authorization: `Bearer ${session.accessToken}` },
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new Client(socket);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async next<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    for (let i = 0; i < 200; i += 1) {
      const found = this.received.find((m) => m.t === t);
      if (found) return found as Extract<ServerMessage, { t: T }>;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${t}`);
  }

  /** Waits for a ping's pong, so every frame the server sent before it has arrived. */
  async settle(): Promise<void> {
    const before = this.received.filter((m) => m.t === "pong").length;
    this.send({ t: "ping" });
    for (let i = 0; i < 200; i += 1) {
      if (this.received.filter((m) => m.t === "pong").length > before) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no pong");
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
}

/** Ben's saved term, from a line he read in an earlier call: someone else's words. */
const SAVED: GlossaryEntry = {
  source: "mi hermana",
  target: "my big sister",
  sourceDialect: "es-AR",
  targetDialect: "en-US",
};

/** Every glossary entry a client was sent, by any message. */
function glossarySeen(client: Client): GlossaryEntry[] {
  return client.received.flatMap((m) => {
    if (m.t === "glossary.updated") return m.entries;
    if (m.t === "room.joined") return m.snapshot.glossary;
    return [];
  });
}

/** Ben (en-US, with SAVED) and Carla (es-AR, nothing saved) in one room, Ben hosting or not. */
async function benAndCarla(benHosts: boolean) {
  const benSession = await signup("Ben");
  const carlaSession = await signup("Carla");
  account.setGlossary(benSession.user.id, { entries: [SAVED] });
  const host = await Client.connect(benHosts ? benSession : carlaSession);
  host.send({ t: "room.create", username: benHosts ? "Ben" : "Carla", dialect: benHosts ? "en-US" : "es-AR", wantsVideo: false });
  const created = await host.next("room.created");
  const guest = await Client.connect(benHosts ? carlaSession : benSession);
  guest.send({ t: "room.join", code: created.code, username: benHosts ? "Carla" : "Ben", dialect: benHosts ? "es-AR" : "en-US" });
  await guest.next("room.joined");
  await host.next("peer.joined");
  const [ben, carla] = benHosts ? [host, guest] : [guest, host];
  await ben.settle();
  await carla.settle();
  return { ben, carla };
}

describe("a saved term", () => {
  it.each([
    ["Ben hosts and Carla joins", true],
    ["Carla hosts and Ben joins", false],
  ])("never reaches the other person's browser (%s)", async (_label, benHosts) => {
    const { ben, carla } = await benAndCarla(benHosts);
    expect(glossarySeen(carla).map((e) => e.source)).not.toContain(SAVED.source);
    // Nor does it come back as the room's glossary to its owner: it is not the room's.
    expect(glossarySeen(ben).map((e) => e.source)).not.toContain(SAVED.source);
  });

  it("shapes the translations its owner reads, and only those", async () => {
    const { ben, carla } = await benAndCarla(true);

    // Carla speaks; Ben reads the translation into en-US. His saved term is in that prompt.
    carla.send({ t: "stt.final", text: "mi hermana viene mañana", seq: 1 });
    await until(() => prompts.length === 1);
    expect(prompts[0]).toContain(SAVED.target);

    // Ben speaks; Carla reads the translation into es-AR. Ben's term is not in hers.
    ben.send({ t: "stt.final", text: "see you tomorrow", seq: 1 });
    await until(() => prompts.length === 2);
    expect(prompts[1]).not.toContain(SAVED.target);
  });

  it("made in one call, reaches the prompt of the next call its author reads, and nobody else's", async () => {
    // Call 1: Carla hosts, Ben reads her line and corrects a term in it.
    const benSession = await signup("Ben");
    const carla = await Client.connect(await signup("Carla"));
    carla.send({ t: "room.create", username: "Carla", dialect: "es-AR", wantsVideo: false });
    const created = await carla.next("room.created");
    const ben = await Client.connect(benSession);
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "en-US" });
    await ben.next("room.joined");
    carla.send({ t: "stt.final", text: "qué hacés, che", seq: 1 });
    const { line } = await ben.next("transcript.final");
    ben.send({ t: "glossary.correct", lineId: line.lineId, source: "che", correctedTranslation: "hey dude" });
    await ben.next("glossary.updated");
    ben.send({ t: "room.leave" });
    await until(() => account.glossaryFor(benSession.user.id).length > 0);

    // Call 2: Ben hosts Dan. Dan's line, read by Ben, carries the term; nothing Dan reads does.
    prompts.length = 0;
    const host = await Client.connect(benSession);
    host.send({ t: "room.create", username: "Ben", dialect: "en-US", wantsVideo: false });
    const second = await host.next("room.created");
    const dan = await Client.connect(await signup("Dan"));
    dan.send({ t: "room.join", code: second.code, username: "Dan", dialect: "es-AR" });
    await dan.next("room.joined");
    await host.next("peer.joined");
    dan.send({ t: "stt.final", text: "che, vení", seq: 1 });
    await until(() => prompts.length === 1);
    expect(prompts[0]).toContain("hey dude");
    host.send({ t: "stt.final", text: "coming", seq: 1 });
    await until(() => prompts.length === 2);
    expect(prompts[1]).not.toContain("hey dude");
    await dan.settle();
    expect(glossarySeen(dan).map((e) => e.target)).not.toContain("hey dude");
  });

  it("stops applying once its owner has left the room", async () => {
    const { ben, carla } = await benAndCarla(false);
    ben.send({ t: "room.leave" });
    await carla.next("peer.left");

    const danSession = await signup("Dan");
    const dan = await Client.connect(danSession);
    const code = (carla.received.find((m) => m.t === "room.created") as Extract<ServerMessage, { t: "room.created" }>).code;
    dan.send({ t: "room.join", code, username: "Dan", dialect: "en-US" });
    await dan.next("room.joined");

    carla.send({ t: "stt.final", text: "mi hermana viene mañana", seq: 1 });
    await until(() => prompts.length === 1);
    expect(prompts[0]).not.toContain(SAVED.target);
  });
});
