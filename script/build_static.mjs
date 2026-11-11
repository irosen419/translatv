#!/usr/bin/env node
// Build the web client as a static site that talks to a translatv server on another origin
// (DEPLOY.md, "Two services"). Run as:
//
//   VITE_API_ORIGIN=https://api.example.com npm run build:static
//
// Optional: `-- --out <dir>` builds somewhere other than client/dist (the end to end run does, so
// it never overwrites the one image build).
//
// Refuses without VITE_API_ORIGIN. An empty value is a valid build (the one image deploy's, same
// origin), but not a valid STATIC build: it would ship a bundle whose every request goes to the
// static host itself. The value's shape is checked by vite.config.ts, through the same parser the
// browser uses. After building, check_secrets runs on the output, because this bundle carries an
// inlined VITE_ value by design and the gate must have looked at exactly these files.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const origin = (process.env["VITE_API_ORIGIN"] ?? "").trim();
if (origin === "") {
  console.error(
    "build:static needs VITE_API_ORIGIN, the API server's origin, for example\n" +
      "  VITE_API_ORIGIN=https://api.example.com npm run build:static\n" +
      "For the one image deploy (client and API on one origin) use `npm run build` instead.",
  );
  process.exit(1);
}

const flag = process.argv.indexOf("--out");
const out = flag !== -1 && process.argv[flag + 1] ? resolve(process.argv[flag + 1]) : join(repoRoot, "client", "dist");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm", ["run", "build", "--workspace=client", "--", "--outDir", out, "--emptyOutDir"]);
run(process.execPath, [join(repoRoot, "script", "check_secrets.mjs"), "--dist", out]);
console.log(`build:static wrote ${out}, for an API at ${origin}.`);
console.log("Copy deploy/static/_headers.example and _redirects.example in beside it (DEPLOY.md, \"Two services\").");
