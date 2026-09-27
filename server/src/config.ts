// Environment configuration, parsed and validated once at boot.
//
// Fails fast on anything that would otherwise fail deep inside a request. The one deliberate
// exception is ANTHROPIC_API_KEY: the app is genuinely useful without it (the call works, the
// original language subtitles work, only translation degrades), so a missing key is a loud
// warning and a documented degraded mode rather than a refusal to start.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RTCIceServerConfig } from "@translatv/shared";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function loadDotEnv(root: string): void {
  // A three line .env reader rather than a dependency. It handles KEY=value, comments, blank
  // lines, and surrounding quotes, which is the whole surface this project needs.
  let text: string;
  try {
    text = readFileSync(join(root, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue; // a real env var always wins
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export interface Config {
  port: number;
  repoRoot: string;
  /** Allowed Origins for the WebSocket upgrade. The CSRF equivalent for a cookie-less app. */
  allowedOrigins: string[];
  anthropicApiKey: string | null;
  /**
   * The one admin password, or null when none is configured.
   *
   * Null means NOBODY can prove they are the admin, so every gate that asks for it refuses.
   * That is why production refuses to boot without one rather than defaulting to open: a
   * deployment that forgot the variable would otherwise let anyone start a call.
   *
   * Deliberately NOT exposed to the client under any name, and never VITE_ prefixed, which
   * would inline it into the bundle for every visitor. `npm run check:secrets` enforces that.
   */
  adminPassword: string | null;
  dailyCapUsd: number;
  roomCapUsd: number;
  iceServers: RTCIceServerConfig[];
  isProduction: boolean;
  /**
   * Trust the nearest (rightmost) hop of X-Forwarded-For for the client address.
   *
   * Opt in, NOT implied by NODE_ENV. Production does not mean a proxy is in front: this repo's
   * own docker-compose maps 8080 straight through. When the header is trusted with nothing
   * behind it, an attacker sets a fresh value per request and every per IP limit evaporates,
   * including the join limiter that is the only real defense on room codes.
   */
  trustProxy: boolean;
  /**
   * Where the SQLite database lives (DATA_DIR, default data/ under the repo root). In production
   * this must be a mounted volume: the boot guard refuses an image layer directory, because a
   * redeploy would delete every account in it.
   */
  dataDir: string;
  /** The database file inside dataDir. */
  databasePath: string;
}

/** The database file's name inside DATA_DIR. */
export const DATABASE_FILE = "translatv.db";

export function loadConfig(repoRoot: string): Config {
  loadDotEnv(repoRoot);

  const key = (process.env["ANTHROPIC_API_KEY"] ?? "").trim();
  // NOT trimmed the way the API key is. A password is whatever the owner typed, and silently
  // eating a leading or trailing space would make a correct password fail with no way to see why.
  const adminPassword = process.env["ADMIN_PASSWORD"] ?? "";

  const origins = (process.env["ORIGIN"] ?? "http://localhost:5173,http://localhost:8080")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // A public STUN server is enough for most home networks. TURN is what carries the roughly 10
  // to 15 percent of pairs behind symmetric NAT or a corporate firewall, and without it those
  // calls fail silently at the media layer while the WebSocket stays perfectly healthy.
  const iceServers: RTCIceServerConfig[] = [{ urls: "stun:stun.l.google.com:19302" }];

  // All three TURN variables, or none of them. A partial set is refused rather than patched up
  // with empty strings, which is what this used to do.
  //
  // The empty string version was the worst available failure. It produced a TURN entry the
  // browser accepted and then could not use, because a relay allocation with no credentials is
  // rejected by every TURN server, as RFC 8656 requires. So the exact calls TURN is bought to
  // carry still failed at the media layer, and the boot log announced "STUN and TURN" while they
  // did. Nobody sets TURN_URL by accident, so a half set trio is always a mistake, and the
  // cheapest place to find out is here rather than from the one person whose network needs it.
  const turnUrl = (process.env["TURN_URL"] ?? "").trim();
  const turnUsername = (process.env["TURN_USERNAME"] ?? "").trim();
  const turnCredential = (process.env["TURN_CREDENTIAL"] ?? "").trim();
  const turnSet = [
    ["TURN_URL", turnUrl],
    ["TURN_USERNAME", turnUsername],
    ["TURN_CREDENTIAL", turnCredential],
  ] as const;

  if (turnSet.some(([, value]) => value)) {
    // Every missing name at once, so a deploy is fixed in one pass rather than one restart per
    // variable.
    const missing = turnSet.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      // The static half deliberately names NO variables. It used to read "set all three of
      // TURN_URL, TURN_USERNAME and TURN_CREDENTIAL", which meant every message contained every
      // name, so a test asserting the message named the missing one passed even when the dynamic
      // half named the wrong one. Review caught that: four mutations of the dynamic half survived
      // the suite. Keeping the names out of the static text is what lets the tests tell the
      // cases apart.
      throw new Error(
        `TURN is half configured: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} ` +
          "missing or blank. Set all three TURN variables, or none of them. A TURN server with " +
          "no credentials rejects every relay allocation, so a partial set looks configured and " +
          "carries no calls.",
      );
    }
    iceServers.push({ urls: turnUrl, username: turnUsername, credential: turnCredential });
  }

  // Relative paths resolve against the repo root, not the working directory, so `npm start` from
  // the root and `npm start --workspace=server` agree on which database they open.
  const dataDirRaw = (process.env["DATA_DIR"] ?? "").trim();
  const dataDir = resolve(repoRoot, dataDirRaw === "" ? "data" : dataDirRaw);

  return {
    port: num("PORT", 8080),
    repoRoot,
    allowedOrigins: origins,
    anthropicApiKey: key.length > 0 ? key : null,
    adminPassword: adminPassword.length > 0 ? adminPassword : null,
    dailyCapUsd: num("ANTHROPIC_DAILY_CAP_USD", 10),
    roomCapUsd: num("ROOM_CAP_USD", 1.5),
    iceServers,
    isProduction: process.env["NODE_ENV"] === "production",
    trustProxy: (process.env["TRUST_PROXY"] ?? "").trim() === "1",
    dataDir,
    databasePath: join(dataDir, DATABASE_FILE),
  };
}

/** Human readable boot report. Says plainly what will and will not work. */
export function describeConfig(config: Config): string[] {
  const lines = [
    `listening on port ${config.port}`,
    `allowed origins: ${config.allowedOrigins.join(", ")}`,
    `ICE servers: ${config.iceServers.length} (${config.iceServers.length > 1 ? "STUN and TURN" : "STUN only"})`,
  ];

  if (config.iceServers.length === 1) {
    lines.push(
      "  no TURN configured: calls will fail for roughly 10 to 15 percent of network pairs. " +
        "Transcripts still work, so those calls degrade to text rather than failing outright.",
    );
  }

  if (config.adminPassword === null) {
    lines.push(
      "ADMIN_PASSWORD is NOT set: admin gating is OFF and ANYONE can start a call.",
      "  Acceptable on a development machine, refused in production. Set it before going live.",
    );
  } else {
    lines.push("admin gating is on: starting a call requires the admin password");
  }

  if (config.anthropicApiKey === null) {
    lines.push(
      "ANTHROPIC_API_KEY is NOT set: translation is DISABLED.",
      "  The call, the transcript, and the original language subtitles all still work.",
      "  Every line will show its original text where the translation would go, marked as",
      "  unavailable. Set the key in .env to enable translation.",
    );
  } else {
    lines.push(
      `translation enabled, caps: $${config.dailyCapUsd.toFixed(2)}/day, ` +
        `$${config.roomCapUsd.toFixed(2)}/room`,
    );
  }

  return lines;
}
