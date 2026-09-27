// The origin label on a translation result.
//
// This used to be computed as `sourceDialect === targetDialect ? "echo" : "model"`, an EXACT
// dialect comparison, while the decision to skip the model compared BASE language. So an en-US
// to en-GB line was echoed verbatim and then reported as having come from a model. Small lie,
// but the wire format is the contract between the two halves of this app, and a field that
// misreports where text came from is the kind of thing someone later trusts.

import { describe, expect, it } from "vitest";

import { originFor } from "./server.js";

describe("originFor", () => {
  it("calls a real translation what it is", () => {
    expect(originFor("en-US", "es-AR")).toBe("model");
    expect(originFor("es-MX", "en-GB")).toBe("model");
  });

  it("calls a same language pair an echo even when the dialects differ", () => {
    expect(originFor("en-US", "en-GB")).toBe("echo");
    expect(originFor("es-AR", "es-MX")).toBe("echo");
  });

  it("calls an identical dialect an echo", () => {
    expect(originFor("en-US", "en-US")).toBe("echo");
  });
});
