# The web client as a static site: example host configs

Examples only. Nothing in this directory is read by any host on its own, and this repository has
no `render.yaml` or other auto deploy file: deploying is a deliberate act (DEPLOY.md, "Two
services: a static site and the API").

| File | What it is |
| --- | --- |
| `_headers.example` | Cloudflare Pages (and Netlify) headers: the strict CSP, nosniff, referrer and permissions policies, caching. Copy to `client/dist/_headers`. |
| `_redirects.example` | Cloudflare Pages (and Netlify) SPA fallback, so `/r/<code>` serves `index.html`. Copy to `client/dist/_redirects`. |
| `nginx.conf.example` | The same headers and fallback for nginx. |

In each, replace `api.example.com` with the API's hostname. The CSP's `connect-src` names it twice,
once as `https://` for the account API and once as `wss://` for the socket. Both are needed.

## Render, as a static site (a description, not a blueprint)

If the static half goes on Render, create a Static Site by hand in the dashboard:

- Build command: `npm ci && VITE_API_ORIGIN=https://api.example.com npm run build:static`
- Publish directory: `client/dist`
- Environment: `VITE_API_ORIGIN=https://api.example.com` (public, inlined into the bundle; never put
  a secret behind `VITE_`), and `NODE_VERSION=22.16.0` or newer.
- Redirects and rewrites: one rewrite, source `/*`, destination `/index.html`.
- Headers: path `/*`, each header from `_headers.example`, with the CSP's API hostname filled in.

The API half is the existing Docker image with `SERVE_CLIENT=0` and the static site's origin in
`ORIGIN`.
