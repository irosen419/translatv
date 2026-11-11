// Parsing VITE_API_ORIGIN: the origin of the translatv server, when it is not the page's own.
//
// Pure and free of import.meta, because two very different places run it: vite.config.ts at build
// time (so a bad value stops the build) and apiBase.ts in the browser (so a bundle built some other
// way still refuses at first load). Both must reach the same verdict on the same string.
//
// The value is PUBLIC. It is an address every visitor's browser connects to, and it is inlined
// into the bundle on purpose. It is never a secret, and nothing secret may ever be put behind a
// VITE_ prefix (CLAUDE.md); `npm run check:secrets` greps the built bundle for that.

/**
 * The normalized origin ("https://api.example.com"), or "" for unset or blank, which means same
 * origin: requests stay relative and the socket follows the page, exactly as before this existed.
 *
 * Throws on anything else that is not an absolute http(s) origin. A path, query, fragment or
 * credentials are refused rather than dropped, because a value someone wrote with a path in it
 * means they expect the path to be used, and silently ignoring it sends requests somewhere they
 * did not intend.
 */
export function parseApiOrigin(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "") return "";

  const refuse = (why: string): never => {
    // The value is not repeated when it carries credentials, so a refusal never prints a password.
    throw new Error(
      `VITE_API_ORIGIN must be an absolute http or https origin such as https://api.example.com, ` +
        `with no path, query, fragment or credentials (${why}). Leave it empty to use the page's own origin.`,
    );
  };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse("not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return refuse(`scheme ${url.protocol}`);
  if (url.username !== "" || url.password !== "") return refuse("it carries credentials");
  if (url.hostname === "") return refuse("no host");
  if (url.pathname !== "/" && url.pathname !== "") return refuse("it has a path");
  if (url.search !== "" || value.includes("?")) return refuse("it has a query");
  if (url.hash !== "" || value.includes("#")) return refuse("it has a fragment");
  return url.origin;
}
