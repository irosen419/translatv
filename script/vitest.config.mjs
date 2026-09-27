import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// A fourth vitest project, for the tooling in script/.
//
// The three workspace configs each include only "src/**/*.test.ts" inside their own workspace, so
// nothing in script/ was ever covered: not the dash gate, not the spend view gate, not the end to
// end harness. This gives that code a home, starting with the latency aggregation, which is pure
// arithmetic that decides whether a reported number is a measurement or a lie.
//
// Plain .mjs on purpose. This project runs inside `npm test`, and the engines floor is Node 22.13,
// where importing a .ts file is not possible without a loader. Everything under test here must therefore stay free
// of TypeScript imports. The harness that DOES import server code runs on demand instead.
// Rooted at this directory rather than left to default to the working directory, so `include`
// means the same thing whether vitest is invoked from the repo root or from anywhere else.
export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    include: ["*.test.mjs"],
    environment: "node",
  },
});
