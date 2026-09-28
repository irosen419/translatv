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

describe("signing the socket in", () => {
  /** Records what each `new WebSocket(...)` was given, and lets a test open or close it. */
  class FakeWebSocket {
    static made: FakeWebSocket[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(
      readonly url: string,
      readonly protocols?: string[],
    ) {
      FakeWebSocket.made.push(this);
    }
    send(): void {}
    close(): void {
      this.onclose?.({ code: 1000 });
    }
  }

  function withFakeSocket(fn: () => Promise<void>): Promise<void> {
    const original = Reflect.getOwnPropertyDescriptor(globalThis, "WebSocket");
    FakeWebSocket.made = [];
    Object.defineProperty(globalThis, "WebSocket", { value: FakeWebSocket, configurable: true, writable: true });
    return fn().finally(() => {
      if (original) Reflect.defineProperty(globalThis, "WebSocket", original);
      else Reflect.deleteProperty(globalThis, "WebSocket");
    });
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const quiet = { onMessage: () => {}, onOpen: () => {}, onClose: () => {}, onReconnecting: () => {} };

  it("offers the access token as a subprotocol, and never puts it in the URL", () =>
    withFakeSocket(async () => {
      const client = new SignalingSocket("ws://localhost:5173/ws", quiet, async () => "access.token");
      client.connect();
      await flush();
      const made = FakeWebSocket.made[0];
      expect(made?.protocols).toEqual(["translatv.v1", "bearer.access.token"]);
      expect(made?.url).not.toContain("access.token");
      client.close();
    }));

  it("asks for a FRESH token after an upgrade that never opened, which is how a 401 looks", () =>
    withFakeSocket(async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      try {
        const asked: boolean[] = [];
        const client = new SignalingSocket("ws://localhost:5173/ws", quiet, async ({ force }) => {
          asked.push(force);
          return `token-${asked.length}`;
        });
        client.connect();
        await vi.advanceTimersByTimeAsync(0);
        FakeWebSocket.made[0]?.onclose?.({ code: 1006 });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(asked).toEqual([false, true]);
        expect(FakeWebSocket.made[1]?.protocols).toEqual(["translatv.v1", "bearer.token-2"]);
        client.close();
      } finally {
        vi.useRealTimers();
      }
    }));

  it("backs off and retries when a token cannot be had right now, rather than giving up", () =>
    withFakeSocket(async () => {
      // A refresh that could not reach the server (a blip mid call) throws. That is not "signed
      // out", and a call must come back from it on its own once the server answers again.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      try {
        const events: string[] = [];
        let asked = 0;
        const client = new SignalingSocket(
          "ws://localhost:5173/ws",
          {
            ...quiet,
            onClose: ({ terminal }) => events.push(`close:${terminal}`),
            onReconnecting: (attempt) => events.push(`reconnecting:${attempt}`),
          },
          async () => {
            asked += 1;
            if (asked === 1) throw new Error("the server could not be reached");
            return "token-2";
          },
        );
        client.connect();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(events.slice(0, 2)).toEqual(["close:false", "reconnecting:1"]);
        expect(FakeWebSocket.made).toHaveLength(1);
        expect(FakeWebSocket.made[0]?.protocols).toEqual(["translatv.v1", "bearer.token-2"]);
        client.close();
      } finally {
        vi.useRealTimers();
      }
    }));

  it("opens nothing when closed while its token was still being fetched", () =>
    withFakeSocket(async () => {
      let release: (token: string) => void = () => {};
      const client = new SignalingSocket(
        "ws://localhost:5173/ws",
        quiet,
        () => new Promise<string>((resolve) => (release = resolve)),
      );
      client.connect();
      client.close();
      release("late.token");
      await flush();
      expect(FakeWebSocket.made).toHaveLength(0);
    }));

  it("stops, and says signed out, when there is no session to connect with", () =>
    withFakeSocket(async () => {
      const events: string[] = [];
      const client = new SignalingSocket(
        "ws://localhost:5173/ws",
        {
          ...quiet,
          onSignedOut: () => events.push("signedOut"),
          onClose: ({ terminal }) => events.push(`close:${terminal}`),
        },
        async () => null,
      );
      client.connect();
      await flush();
      expect(events).toEqual(["signedOut", "close:true"]);
      expect(FakeWebSocket.made).toHaveLength(0);
    }));
});

describe("the dev proxy carries the account API", () => {
  it("forwards /api, or nobody can sign in under npm run dev", () => {
    const proxy = viteConfig.server?.proxy ?? {};
    expect(Object.keys(proxy)).toContain("/api");
  });
});
