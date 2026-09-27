#!/usr/bin/env node
// Sets up, or reports on, testing against a phone on the same wifi.
//
// This exists because the phone case has three failure modes that all look like "it just does not
// work", and each one is invisible from the phone:
//
//   getUserMedia refuses outside a secure context, so a plain http LAN address cannot open a
//     microphone at all. This is the one that stops people.
//   the dev server binds to localhost by default, so the phone cannot reach it.
//   the WebSocket origin check has to accept the LAN origin, or the page loads and the socket 403s.
//
// Run it with no arguments to see where you stand and what to do next.

import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = join(repoRoot, "certs", "dev-key.pem");
const CERT = join(repoRoot, "certs", "dev.pem");

/** Every address a phone on the same network could plausibly reach this machine on. */
function lanAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      found.push({ name, address: addr.address });
    }
  }
  return found;
}

const addresses = lanAddresses();
const ready = existsSync(KEY) && existsSync(CERT);

console.log("");
if (addresses.length === 0) {
  console.log("No LAN address found. This machine is not on a network a phone could reach it on.");
  console.log("");
  process.exit(0);
}

console.log("This machine is reachable at:");
for (const { name, address } of addresses) console.log(`  ${address}  (${name})`);
console.log("");

const primary = addresses[0].address;

if (!ready) {
  console.log("Local TLS is NOT set up, so a phone cannot use the microphone yet.");
  console.log("A phone needs https: getUserMedia refuses on a plain http LAN address, and the");
  console.log("app will say so rather than appearing broken.");
  console.log("");
  console.log("To set it up:");
  console.log("");
  console.log("  brew install mkcert nss   # or your platform's equivalent");
  console.log("  mkcert -install");
  console.log("  mkdir -p certs");
  console.log(`  mkcert -cert-file certs/dev.pem -key-file certs/dev-key.pem localhost ${primary}`);
  console.log("");
  console.log("Then trust mkcert's root certificate ON THE PHONE too. Print its location with:");
  console.log("");
  console.log("  mkcert -CAROOT");
  console.log("");
  console.log("TESTING.md has the iOS steps, which are a profile install AND a separate switch");
  console.log("under Certificate Trust Settings. Missing the second one looks like a broken cert.");
  console.log("");
  process.exit(0);
}

console.log("Local TLS is set up. `npm run dev` will serve https and bind to every interface.");
console.log("");
console.log("On the phone, open:");
console.log("");
console.log(`  https://${primary}:5173`);
console.log("");
console.log("If the phone reports the certificate is untrusted, the root certificate is not");
console.log("trusted there yet. `mkcert -CAROOT` prints where it lives; TESTING.md has the steps.");
console.log("");
