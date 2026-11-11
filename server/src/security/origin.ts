// Which browser origins this server trusts: one rule, read by the WebSocket upgrade and by CORS.
//
// One function rather than two copies, because the two checks are the same question asked at two
// doors. If CORS let a static site's origin read the account API while the socket refused it, the
// split deployment would sign people in and then fail every call; the reverse would open a socket
// to a page that cannot sign in. Either drift is a confusing half outage, so they cannot drift.

import type { Config } from "../config.js";

/**
 * Whether a browser on `origin` may use this server: listed in ORIGIN, or (development only) a
 * page served from this machine or its local network.
 *
 * Production stays strict: there, the allowlist is the whole CSRF defense for the socket, and the
 * whole list of pages allowed to read the account API's answers.
 */
export function originAllowed(config: Pick<Config, "allowedOrigins" | "isProduction">, origin: string): boolean {
  return config.allowedOrigins.includes(origin) || (!config.isProduction && isDevelopmentOrigin(origin));
}

/**
 * Whether an Origin points at this machine or at the local network it is on.
 *
 * Parsed rather than string matched: "http://localhost.evil.com" contains "localhost" and is
 * emphatically not local, and "http://192.168.1.5.evil.example" starts with a private address
 * and is not one. A substring check waves both through.
 *
 * This is a DEVELOPMENT only relaxation, and it is narrower than it looks. A browser sets Origin
 * itself and a page cannot forge it, so a hostile site still arrives as its own origin and is
 * still refused. The only thing admitted here is a page genuinely served from a loopback or
 * private address, which on a development machine is this app being opened from a phone.
 */
export function isDevelopmentOrigin(origin: string): boolean {
  let hostname: string;
  try {
    ({ hostname } = new URL(origin));
  } catch {
    return false;
  }

  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;

  // RFC 1918 plus the link local range phones fall back to when DHCP is slow. Each octet is
  // compared as a number, so 172.32.0.1 is correctly outside 172.16.0.0/12 rather than matching
  // a "172." prefix.
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  const [a, b] = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) return false;
  if (octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;

  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
