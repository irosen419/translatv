import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Local TLS, for testing against a phone, if it has been set up.
 *
 * A phone cannot use this app over a plain LAN address: getUserMedia requires a secure context
 * and http://192.168.x.x is not one, so the call is refused before it starts. mkcert solves that
 * without involving the internet. TESTING.md covers the phone side, which needs the root
 * certificate trusted there as well as generated here.
 *
 * The presence of the files IS the switch. Generating them is a deliberate act, so serving over
 * TLS and binding to every interface follows from it rather than needing a second flag. With no
 * certs this stays exactly what it was: http, this machine only.
 */
function localTls(): { key: Buffer; cert: Buffer } | undefined {
  const key = join(repoRoot, "certs", "dev-key.pem");
  const cert = join(repoRoot, "certs", "dev.pem");
  if (!existsSync(key) || !existsSync(cert)) return undefined;
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const https = localTls();

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Every interface only in LAN mode. Without certs the dev server stays local, which is both
    // vite's default and the right one: exposure should follow from asking for it.
    host: https ? true : "localhost",
    // In LAN mode the URL is being typed by hand on a phone, from what `npm run lan` printed.
    // Vite's default is to hop to the next free port, which would silently make that printed URL
    // wrong and look like the phone cannot reach the machine. Fail loudly instead.
    strictPort: Boolean(https),
    ...(https ? { https } : {}),
    proxy: {
      // The dev client talks to the dev server over the same origin, so the Origin check on
      // the WebSocket upgrade behaves the same in development as in production. This key is the
      // path the client builds its socket URL from: they are asserted equal in socket.test.ts,
      // because when they drifted apart the socket died with nothing logged on either side.
      "/ws": { target: "ws://localhost:8080", ws: true },
      "/healthz": { target: "http://localhost:8080" },
      // The account API. Without this the dev server answers /api/auth/login itself with a 404
      // and nobody can sign in under npm run dev. The same mistake happened once with the admin
      // login this replaced: it was driven against the BUILT server, where one origin serves
      // both and no proxy is involved, so nothing noticed.
      "/api": { target: "http://localhost:8080" },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
