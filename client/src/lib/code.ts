// Room code helpers shared by the landing form and the room link parser.
//
// Mirrors the server's normalizeCode: the same lookalike folds, applied client side so the
// form can validate before a round trip and so a link with a mistyped O still resolves.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8;

export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

export function isLikelyCode(input: string): boolean {
  const normalized = normalizeCode(input);
  return (
    normalized.length === CODE_LENGTH && [...normalized].every((char) => ALPHABET.includes(char))
  );
}

/** Read a room code out of a /r/<code> path, so a shared link opens the join form filled in. */
export function codeFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/r\/([^/]+)\/?$/);
  if (!match?.[1]) return null;
  const normalized = normalizeCode(decodeURIComponent(match[1]));
  return isLikelyCode(normalized) ? normalized : null;
}

/**
 * Read a room code out of anything someone might paste into the join field: a full link, a link
 * that lost its scheme, or a bare path. Returns null for a bare code so ordinary typing is left
 * alone by the caller.
 *
 * The URL branch cannot return its first answer directly. "localhost:5173/r/ABCD1234" parses as a
 * URL with protocol "localhost:" and pathname "5173/r/ABCD1234", so a successful parse is not the
 * same as a successful read, and a null from it has to fall through to the substring search.
 */
export function codeFromShared(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const fromUrl = codeFromPath(new URL(trimmed).pathname);
    if (fromUrl) return fromUrl;
  } catch {
    // Not a parseable URL. The substring search below still handles a bare path.
  }

  const at = trimmed.indexOf("/r/");
  if (at === -1) return null;
  // Only the URL branch strips these for us, so the fallback has to do it itself.
  const path = trimmed.slice(at).split(/[?#]/)[0] ?? "";
  return codeFromPath(path);
}

/** The shareable link for a room. */
export function roomLink(code: string): string {
  return `${location.origin}/r/${code}`;
}
