import { describe, expect, it } from "vitest";
import { APP_SUBPROTOCOL, bearerFromHeader, bearerFromUpgrade, selectSubprotocol } from "./bearer.js";

describe("bearerFromHeader", () => {
  it("reads a Bearer credential", () => {
    expect(bearerFromHeader("Bearer abc.def")).toBe("abc.def");
    expect(bearerFromHeader("bearer abc.def")).toBe("abc.def");
  });

  it("answers null for anything else", () => {
    for (const value of [undefined, "", "Bearer", "Bearer ", "Basic abc", "Bearer a b", ["Bearer x"]]) {
      expect(bearerFromHeader(value as string | undefined)).toBe(null);
    }
  });
});

describe("bearerFromUpgrade", () => {
  it("prefers the Authorization header, which is what a native client sends", () => {
    expect(
      bearerFromUpgrade({ authorization: "Bearer from.header", "sec-websocket-protocol": "translatv.v1, bearer.from.proto" }),
    ).toBe("from.header");
  });

  it("reads the token a browser offers as a subprotocol, since it cannot set headers", () => {
    expect(bearerFromUpgrade({ "sec-websocket-protocol": `${APP_SUBPROTOCOL}, bearer.abc.def` })).toBe("abc.def");
  });

  it("answers null when neither carries one", () => {
    expect(bearerFromUpgrade({})).toBe(null);
    expect(bearerFromUpgrade({ "sec-websocket-protocol": APP_SUBPROTOCOL })).toBe(null);
    expect(bearerFromUpgrade({ "sec-websocket-protocol": "bearer." })).toBe(null);
  });
});

describe("selectSubprotocol", () => {
  it("answers with the app protocol and never echoes the token back", () => {
    expect(selectSubprotocol(new Set([APP_SUBPROTOCOL, "bearer.secret"]))).toBe(APP_SUBPROTOCOL);
  });

  it("selects nothing when the app protocol was not offered", () => {
    expect(selectSubprotocol(new Set(["bearer.secret"]))).toBe(false);
    expect(selectSubprotocol(new Set())).toBe(false);
  });
});
