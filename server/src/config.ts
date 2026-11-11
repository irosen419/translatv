// Environment configuration, parsed and validated once at boot.
//
// Fails fast on anything that would otherwise fail deep inside a request. The one deliberate
// exception is ANTHROPIC_API_KEY: the app is genuinely useful without it (the call works, the
// original language subtitles work, only translation degrades), so a missing key is a loud
// warning and a documented degraded mode rather than a refusal to start.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { email as emailSchema, signupMode as signupModeSchema, type RTCIceServerConfig, type SignupMode } from "@translatv/shared";

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
   * The key access tokens are signed under (AUTH_SECRET), or null when none is configured.
   *
   * Null is refused in production by the boot guard in index.ts (auth/secret.ts). In development
   * index.ts generates a random one per process instead and says it did, without printing it.
   *
   * Never VITE_ prefixed and never sent to the client under any name: anyone holding it can mint
   * a session for any account. `npm run check:secrets` enforces the bundle half of that.
   */
  authSecret: string | null;
  /**
   * Who may create an account. "invite" (the default) needs a single use code from the owner;
   * "open" lets anyone. Invite only by default because the daily spend cap is shared, so open
   * signup lets a stranger spend the owner's money down to the cap (docs/PLAN.md, D9).
   */
  signupMode: SignupMode;
  /** The account with this email (normalized) is the owner, who mints invites. Null: no owner. */
  ownerEmail: string | null;
  /**
   * Where people write for help (SUPPORT_EMAIL), shown as a mailto link on the support page and
   * wherever the site says to contact support. Not a secret: /healthz serves it to anyone. Null
   * when unset, and then the site shows no address rather than a broken link.
   */
  supportEmail: string | null;
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
  /**
   * Whether this server also serves the built web client (SERVE_CLIENT, default on).
   *
   * On is the one image deploy: one origin serves the page, the API and the socket. Off is the
   * API half of a split deploy, where the client is a static site on its own origin (DEPLOY.md,
   * "Two services") and this server answers 404 JSON for anything that is not /api, /healthz or
   * the socket. Off does not loosen anything: the static site's origin must still be in ORIGIN,
   * which is what both CORS and the socket's Origin check read.
   */
  serveClient: boolean;
}

/** The database file's name inside DATA_DIR. */
export const DATABASE_FILE = "translatv.db";

export function loadConfig(repoRoot: string): Config {
  loadDotEnv(repoRoot);

  const key = (process.env["ANTHROPIC_API_KEY"] ?? "").trim();
  // Trimmed: a secret is machine generated, so surrounding whitespace is always a paste artifact.
  const authSecret = (process.env["AUTH_SECRET"] ?? "").trim();

  // Refused rather than defaulted when it is set to something unknown. The failure a fallback
  // would hide is the expensive one: a typo read as "open" hands the shared spend cap to anyone.
  const signupRaw = (process.env["SIGNUP_MODE"] ?? "").trim().toLowerCase();
  const signup = signupModeSchema.safeParse(signupRaw === "" ? "invite" : signupRaw);
  if (!signup.success) {
    throw new Error(
      `SIGNUP_MODE must be "invite" or "open", got ${JSON.stringify(process.env["SIGNUP_MODE"])}.`,
    );
  }

  // Normalized exactly as signup normalizes an email, or the owner would never match their own
  // account because of a capital letter.
  const ownerEmail = (process.env["OWNER_EMAIL"] ?? "").trim().toLowerCase();

  // Normalized and checked like a sign up email. Refused rather than ignored when it is set to
  // something that is not an address, since a typo here prints a dead mailto link on every page.
  const supportRaw = (process.env["SUPPORT_EMAIL"] ?? "").trim();
  const support = supportRaw === "" ? null : emailSchema.safeParse(supportRaw);
  if (support && !support.success) {
    throw new Error(`SUPPORT_EMAIL must be an email address, got ${JSON.stringify(process.env["SUPPORT_EMAIL"])}.`);
  }

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

  // Refused rather than defaulted when it is set to something unknown, like SIGNUP_MODE. Either
  // wrong guess is a confusing deploy: a typo read as "on" serves a stale bundle from the API
  // host, and one read as "off" takes the one image deploy's whole site down to 404s.
  const serveRaw = (process.env["SERVE_CLIENT"] ?? "").trim().toLowerCase();
  let serveClient: boolean;
  if (serveRaw === "" || serveRaw === "1" || serveRaw === "true" || serveRaw === "on") serveClient = true;
  else if (serveRaw === "0" || serveRaw === "false" || serveRaw === "off") serveClient = false;
  else {
    throw new Error(
      `SERVE_CLIENT must be on (1, true, on) or off (0, false, off), got ${JSON.stringify(process.env["SERVE_CLIENT"])}.`,
    );
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
    authSecret: authSecret.length > 0 ? authSecret : null,
    signupMode: signup.data,
    ownerEmail: ownerEmail.length > 0 ? ownerEmail : null,
    supportEmail: support && support.success ? support.data : null,
    dailyCapUsd: num("ANTHROPIC_DAILY_CAP_USD", 10),
    roomCapUsd: num("ROOM_CAP_USD", 1.5),
    iceServers,
    isProduction: process.env["NODE_ENV"] === "production",
    trustProxy: (process.env["TRUST_PROXY"] ?? "").trim() === "1",
    dataDir,
    databasePath: join(dataDir, DATABASE_FILE),
    serveClient,
  };
}

/** Human readable boot report. Says plainly what will and will not work. */
export function describeConfig(config: Config): string[] {
  const lines = [
    `listening on port ${config.port}`,
    `allowed origins: ${config.allowedOrigins.join(", ")}`,
    config.serveClient
      ? "serving the web client from this server (SERVE_CLIENT on)"
      : "API only (SERVE_CLIENT off): the web client is served elsewhere, and its origin must be in ORIGIN",
    `ICE servers: ${config.iceServers.length} (${config.iceServers.length > 1 ? "STUN and TURN" : "STUN only"})`,
  ];

  if (config.iceServers.length === 1) {
    lines.push(
      "  no TURN configured: calls will fail for roughly 10 to 15 percent of network pairs. " +
        "Transcripts still work, so those calls degrade to text rather than failing outright.",
    );
  }

  lines.push(
    config.signupMode === "open"
      ? "signup is OPEN: anyone who can reach this server can create an account and start calls"
      : "signup is invite only: mint invites with `npm run invite` (in the image, " +
        "`node server/dist/cli/invite.js`) or as the owner",
  );
  lines.push(
    config.ownerEmail === null
      ? "OWNER_EMAIL is not set: no account is the owner, so only the invite CLI can mint invites"
      : "an owner account is configured (OWNER_EMAIL)",
  );
  lines.push(
    config.supportEmail === null
      ? "SUPPORT_EMAIL is not set: the support page shows no contact address"
      : "a support contact is configured (SUPPORT_EMAIL)",
  );

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
