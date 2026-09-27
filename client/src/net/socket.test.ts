// The URL the signaling socket connects to.
//
// This file exists because of a bug that was invisible to every other test. socketUrl() returned
// the bare origin with no path. The server accepted an upgrade on ANY path, so when the client
// was served by the server on one origin, which is exactly what the end to end run does, it
// worked. Under `npm run dev` the client is on the vite port and vite only forwards the one
// proxied prefix, so a socket to the bare origin never reached the app at all: no error thrown,
// nothing logged server side, just a create that vanished and a modal that never moved.
//
// The lesson these tests encode is that the path is part of the wire contract, so it is asserted
// against the SAME constant both sides use, and against the dev proxy that has to carry it.

import { WS_PATH } from "@translatv/shared";
import { describe, expect, it, vi } from "vitest";
import viteConfig from "../../vite.config.js";
import { SignalingSocket, socketUrl } from "./socket.js";

/** vitest runs this suite in a node environment, so `location` has to be supplied. */
function atLocation<T>(location: { protocol: string; host: string }, fn: () => T): T {
  const original = Reflect.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { value: location, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(globalThis, "location", original);
    else Reflect.deleteProperty(globalThis, "location");
  }
}

describe("socketUrl", () => {
  it("includes the signaling path, which is what a dev proxy routes on", () => {
    const url = atLocation({ protocol: "http:", host: "localhost:5173" }, socketUrl);

    // The specific regression: a bare origin here is silently dropped by the dev proxy.
    expect(url).toBe(`ws://localhost:5173${WS_PATH}`);
    expect(new URL(url).pathname).toBe(WS_PATH);
  });

  it("upgrades to wss on an https page without losing the path", () => {
    // Over https both halves have to survive together. An earlier version got the scheme right
    // and the path wrong, which is the combination that still fails.
    const url = atLocation({ protocol: "https:", host: "call.example.com" }, socketUrl);

    expect(url).toBe(`wss://call.example.com${WS_PATH}`);
    expect(new URL(url).pathname).toBe(WS_PATH);
  });

  it("keeps the port, so the dev client does not connect to the wrong server", () => {
    const url = atLocation({ protocol: "http:", host: "127.0.0.1:4173" }, socketUrl);

    expect(url).toBe(`ws://127.0.0.1:4173${WS_PATH}`);
  });
});

describe("sending before the socket is open", () => {
  const handlers = {
    onMessage: () => {},
    onOpen: () => {},
    onClose: () => {},
    onReconnecting: () => {},
  };

  it("does not throw, because a lost interim result must not break the call", () => {
    const client = new SignalingSocket("ws://localhost:5173/ws", handlers);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Never connected: this is the window between speech starting and the socket opening.
    expect(() => client.send({ t: "stt.final", text: "hola", seq: 1 })).not.toThrow();

    warn.mockRestore();
  });

  it("says so rather than dropping in silence", () => {
    // The whole point. A socket that never connects used to produce a screen that never moved
    // and not one line anywhere explaining it.
    const client = new SignalingSocket("ws://localhost:5173/ws", handlers);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    client.send({ t: "stt.final", text: "hola", seq: 1 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("stt.final");
    warn.mockRestore();
  });

  it("decides it cannot send without reaching for a global WebSocket", () => {
    // The exact CI break. Node did not have a global WebSocket until 22, and this repo's CI pins
    // 20, so `WebSocket.OPEN` threw ReferenceError there while passing on a newer local Node.
    // The comparison is evaluated even when the socket is null, which is precisely the state
    // these tests put it in, so the failure hit only the machine nobody was watching.
    const original = Reflect.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Reflect.deleteProperty(globalThis, "WebSocket");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const client = new SignalingSocket("ws://localhost:5173/ws", handlers);
      expect(() => client.send({ t: "stt.final", text: "hola", seq: 1 })).not.toThrow();
    } finally {
      warn.mockRestore();
      if (original) Reflect.defineProperty(globalThis, "WebSocket", original);
    }
  });

  it("never puts transcript text in that warning", () => {
    // House rule: the logger takes types, counts, and identifiers. Not content.
    const client = new SignalingSocket("ws://localhost:5173/ws", handlers);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    client.send({ t: "stt.final", text: "no secret transcript in a log", seq: 1 });

    expect(String(warn.mock.calls[0]?.[0])).not.toContain("no secret transcript in a log");
    warn.mockRestore();
  });
});

describe("the dev proxy and the socket path agree", () => {
  // The actual invariant that broke. The client built one URL, vite forwarded a different prefix,
  // and nothing compared the two. Asserting it here means a change to either side fails a test
  // rather than failing silently in the one mode no browser test covers.
  it("vite forwards exactly the path the client connects to", () => {
    const proxy = viteConfig.server?.proxy ?? {};

    expect(Object.keys(proxy)).toContain(WS_PATH);
  });

  it("forwards it as a websocket rather than a plain http route", () => {
    const proxy = viteConfig.server?.proxy ?? {};
    const rule = proxy[WS_PATH];

    // Without ws:true the upgrade is not carried and the socket dies at the proxy.
    expect(typeof rule === "object" && rule.ws).toBe(true);
  });
});
