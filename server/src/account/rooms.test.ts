// Per user data meeting the rooms, over REAL sockets and REAL HTTP against a real in memory store:
// a stored glossary joins the room glossary, call history rows open and close with the room's
// own lifecycle, and deleting an account disconnects its live socket.
//
// ws/server.test.ts proves the room wiring with no database behind it. This suite is the one
// place both halves run together, the way index.ts assembles them.

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CLOSE, WS_PATH, type AuthSession, type GlossaryEntry, type ServerMessage } from "@translatv/shared";
import { AuthService } from "../auth/service.js";
import type { Config } from "../config.js";
import { createApp } from "../http.js";
import { GRACE_MS } from "../rooms/RoomManager.js";
import { roomHash, SpendGate } from "../spend/caps.js";
import { openStore, type Store } from "../store/index.js";
import { TranslationService } from "../translate/TranslationService.js";
import { SignalingServer } from "../ws/server.js";
import { AccountService } from "./service.js";

const ORIGIN = "http://localhost:5173";
const PASSWORD = randomBytes(12).toString("hex");

let root: string;
let store: Store;
let auth: AuthService;
let account: AccountService;
let server: Server;
let signaling: SignalingServer;
let base: string;
let port: number;

function config(): Config {
  return {
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
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "acct-rooms-"));
  mkdirSync(join(root, "out", "translatv"), { recursive: true });
  writeFileSync(join(root, "out", "translatv", "spend_log.jsonl"), "", "utf8");
  store = openStore({ path: ":memory:" });
  auth = new AuthService(store, { secret: randomBytes(32).toString("hex"), signupMode: "open", ownerEmail: null });
  account = new AccountService(store);
  const cfg = config();
  // No LLM client: nothing here translates, and nothing here may spend.
  const translation = new TranslationService(null, new SpendGate(root, { dailyCapUsd: 10, roomCapUsd: 1.5 }), root);
  server = createServer(createApp(cfg, join(root, "no-dist"), translation, auth, account));
  signaling = new SignalingServer(server, cfg, translation, auth, account);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
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
  closeCode: number | null = null;
  private readonly waiters: Array<{ t: string; resolve: (m: ServerMessage) => void }> = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.received.push(message);
      const index = this.waiters.findIndex((w) => w.t === message.t);
      if (index !== -1) this.waiters.splice(index, 1)[0]?.resolve(message);
    });
    socket.on("close", (code) => {
      this.closeCode = code;
    });
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

  /** The NEXT message of this type not yet consumed. */
  next<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    const index = this.received.findIndex((m) => m.t === t);
    if (index !== -1) {
      const [found] = this.received.splice(index, 1);
      return Promise.resolve(found as Extract<ServerMessage, { t: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${t}`)), 2_000);
      this.waiters.push({
        t,
        resolve: (m) => {
          clearTimeout(timer);
          const at = this.received.indexOf(m);
          if (at !== -1) this.received.splice(at, 1);
          resolve(m as Extract<ServerMessage, { t: T }>);
        },
      });
    });
  }

  async closed(): Promise<number> {
    if (this.closeCode !== null) return this.closeCode;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not close")), 2_000);
      this.socket.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}

interface Row {
  user_id: string;
  room_hash: string;
  peer_user_id: string | null;
  started_at: number;
  ended_at: number | null;
}

function rowsFor(userId: string): Row[] {
  return store.db
    .prepare("SELECT user_id, room_hash, peer_user_id, started_at, ended_at FROM call_history WHERE user_id = ? ORDER BY started_at")
    .all(userId) as unknown as Row[];
}

/** Rows are written synchronously on the frame that causes them; this waits for that frame. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
}

const pibe: GlossaryEntry = { source: "pibe", target: "kid", sourceDialect: "es-AR", targetDialect: "en-US" };
const chamba: GlossaryEntry = { source: "chamba", target: "job", sourceDialect: "es-MX", targetDialect: "en-US" };

/** A host in a room, and a guest who has joined it. */
async function pair() {
  const anaSession = await signup("Ana");
  const benSession = await signup("Ben");
  const ana = await Client.connect(anaSession);
  ana.send({ t: "room.create", username: "Ana", dialect: "es-AR", wantsVideo: false });
  const created = await ana.next("room.created");
  const ben = await Client.connect(benSession);
  ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "en-US" });
  await ben.next("room.joined");
  await ana.next("peer.joined");
  return { anaSession, benSession, ana, ben, code: created.code };
}

describe("a stored glossary in a room", () => {
  it("is merged into the room glossary when its owner creates the room", async () => {
    const session = await signup("Ana");
    account.setGlossary(session.user.id, { entries: [pibe, chamba] });
    const ana = await Client.connect(session);
    ana.send({ t: "room.create", username: "Ana", dialect: "es-AR", wantsVideo: false });
    await ana.next("room.created");
    const updated = await ana.next("glossary.updated");
    expect(updated.entries).toEqual([pibe, chamba]);
  });

  it("is merged when its owner joins, reaching both people, by the glossary.import rules", async () => {
    const anaSession = await signup("Ana");
    const benSession = await signup("Ben");
    account.setGlossary(anaSession.user.id, { entries: [pibe] });
    // Same source phrase as Ana's: the import rule dedupes on it, most recent first.
    const benPibe = { ...pibe, target: "lad" };
    account.setGlossary(benSession.user.id, { entries: [benPibe, chamba] });

    const ana = await Client.connect(anaSession);
    ana.send({ t: "room.create", username: "Ana", dialect: "es-AR", wantsVideo: false });
    const created = await ana.next("room.created");
    await ana.next("glossary.updated");

    const ben = await Client.connect(benSession);
    ben.send({ t: "room.join", code: created.code, username: "Ben", dialect: "en-US" });
    await ben.next("room.joined");
    const forBen = await ben.next("glossary.updated");
    const forAna = await ana.next("glossary.updated");
    expect(forBen.entries).toEqual([benPibe, chamba]);
    expect(forAna.entries).toEqual(forBen.entries);
  });

  it("sends nothing extra for a user with no stored glossary", async () => {
    const session = await signup("Ana");
    const ana = await Client.connect(session);
    ana.send({ t: "room.create", username: "Ana", dialect: "es-AR", wantsVideo: false });
    await ana.next("room.created");
    ana.send({ t: "ping" });
    await ana.next("pong");
    expect(ana.received.some((m) => m.t === "glossary.updated")).toBe(false);
  });
});

describe("call history from a room's lifecycle", () => {
  it("opens a row per participant, names the peer once both are present, and holds only the hash", async () => {
    const { anaSession, benSession, code } = await pair();
    const ana = rowsFor(anaSession.user.id);
    const ben = rowsFor(benSession.user.id);
    expect(ana).toHaveLength(1);
    expect(ben).toHaveLength(1);
    expect(ana[0]).toMatchObject({ room_hash: roomHash(code), peer_user_id: benSession.user.id, ended_at: null });
    expect(ben[0]).toMatchObject({ room_hash: roomHash(code), peer_user_id: anaSession.user.id, ended_at: null });

    const dump = JSON.stringify(store.db.prepare("SELECT * FROM call_history").all());
    expect(dump).not.toContain(code);
  });

  it("closes the guest's row when they leave, and the host's when the room ends", async () => {
    const { anaSession, benSession, ana, ben } = await pair();
    ben.send({ t: "room.leave" });
    await ben.closed();
    await until(() => rowsFor(benSession.user.id)[0]?.ended_at !== null);
    expect(rowsFor(anaSession.user.id)[0]?.ended_at).toBeNull();

    ana.send({ t: "room.end" });
    await ana.closed();
    await until(() => rowsFor(anaSession.user.id)[0]?.ended_at !== null);
  });

  it("closes both rows when the host leaves, which ends the room", async () => {
    const { anaSession, benSession, ana, ben } = await pair();
    ana.send({ t: "room.leave" });
    await ben.next("room.ended");
    await until(() => rowsFor(anaSession.user.id)[0]?.ended_at !== null);
    await until(() => rowsFor(benSession.user.id)[0]?.ended_at !== null);
  });

  it("closes a row when its member's grace window runs out, not when they merely drop", async () => {
    const { benSession, ben } = await pair();
    ben.socket.close();
    await ben.closed();
    signaling.sweepAt(Date.now() + 1_000);
    expect(rowsFor(benSession.user.id)[0]?.ended_at).toBeNull();

    signaling.sweepAt(Date.now() + GRACE_MS + 1_000);
    expect(rowsFor(benSession.user.id)[0]?.ended_at).not.toBeNull();
  });

  it("derives contacts both ways", async () => {
    const { anaSession, benSession } = await pair();
    expect(account.contactsFor(anaSession.user.id).contacts.map((c) => c.displayName)).toEqual(["Ben"]);
    expect(account.contactsFor(benSession.user.id).contacts.map((c) => c.displayName)).toEqual(["Ana"]);
  });

  it("persists no transcript and no chat anywhere", async () => {
    const { ana } = await pair();
    const secret = `said-${randomBytes(6).toString("hex")}`;
    ana.send({ t: "chat.send", text: secret });
    ana.send({ t: "stt.final", text: secret, seq: 1 });
    await ana.next("transcript.final");
    await ana.next("transcript.final");
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String(r["name"]));
    for (const table of tables) {
      expect(JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(secret);
    }
  });
});

describe("deleting an account with a live socket", () => {
  async function deleteOver(session: AuthSession): Promise<number> {
    const response = await fetch(`${base}/api/account`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ password: PASSWORD, userId: session.user.id }),
    });
    return response.status;
  }

  it("closes the guest's socket normally; the room continues and the host's history keeps the call", async () => {
    const { anaSession, benSession, ana, ben } = await pair();
    expect(await deleteOver(benSession)).toBe(204);

    expect(await ben.closed()).toBe(CLOSE.normal);
    const left = await ana.next("peer.left");
    expect(left.reason).toBe("left");
    expect(ana.closeCode).toBeNull();

    expect(rowsFor(benSession.user.id)).toEqual([]);
    const kept = rowsFor(anaSession.user.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.peer_user_id).toBeNull();
    expect(account.contactsFor(anaSession.user.id).contacts).toEqual([]);
  });

  it("ends the room when the host deletes, by the same rule as the host leaving", async () => {
    const { anaSession, benSession, ana, ben } = await pair();
    expect(await deleteOver(anaSession)).toBe(204);
    expect(await ana.closed()).toBe(CLOSE.normal);
    await ben.next("room.ended");
    const kept = rowsFor(benSession.user.id);
    expect(kept[0]?.peer_user_id).toBeNull();
    expect(kept[0]?.ended_at).not.toBeNull();
  });

  it("closes a socket that is not in any room, and a new upgrade is refused", async () => {
    const session = await signup("Ana");
    const idle = await Client.connect(session);
    expect(await deleteOver(session)).toBe(204);
    expect(await idle.closed()).toBe(CLOSE.normal);
    await expect(Client.connect(session)).rejects.toThrow();
  });
});
