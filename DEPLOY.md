# Deploying

One image, one process. The server serves the built client and handles the WebSocket, so there is
no second service to wire up.

```bash
docker compose up --build
```

That publishes on **loopback only**. It is reachable from the host, and deliberately not from
another machine, because the deploy this file describes puts a tunnel in front and a public bind
there is a security hole rather than a convenience. For a LAN test on a network you trust, set
`BIND_ADDR=0.0.0.0`. Section 7 explains why, and why an override file cannot change it.

Everything below is a thing that will bite you if it is skipped, in rough order of how likely it
is to bite.

## 1. HTTPS is mandatory, and localhost is the only exemption

`getUserMedia` and `SpeechRecognition` both require a secure context. Browsers grant that to
`https://` and to `localhost`, and **not** to a LAN address.

So `http://192.168.1.5:8080` will not work, and it fails in a confusing way: the page loads, the
buttons work, and the microphone permission never appears. This is the single most common way a
WebRTC project loses an afternoon on its first two machine test.

For LAN testing, use `mkcert`:

```bash
mkcert -install
mkcert localhost 192.168.1.5
```

Then terminate TLS in front of the app, or serve the Vite dev server over https with those files.

## 2. Your reverse proxy must forward the WebSocket upgrade

Everything real in this app happens over the WebSocket. A proxy that only forwards HTTP will serve
a page that loads perfectly and then does nothing at all.

nginx:

```nginx
location / {
    proxy_pass         http://app:8080;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade    $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host       $host;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    # A call is a long lived connection. The default 60s read timeout would cut every
    # conversation at the one minute mark.
    proxy_read_timeout 3600s;
}
```

Caddy handles the upgrade and the certificate automatically:

```caddy
chat.example.com {
    reverse_proxy app:8080
}
```

`X-Forwarded-For` matters, and forwarding it is only **half** of what is required. The server
ignores the header unless you also set `TRUST_PROXY=1`, because an attacker controlled header
trusted with nothing in front of it makes every per IP limit bypassable with one line of curl.

Which END of the header is read matters too. The header grows left to right: a client may send
one, and each proxy APPENDS the address it saw. Only the rightmost entry was written by your own
proxy, so that is the one the server reads. Everything left of it came from the caller and can
say anything.

**This assumes exactly ONE proxy in front.** Cloudflare talking straight to this container is
fine. Cloudflare, then nginx, then the container is not: by the time nginx appends, the rightmost
entry is a Cloudflare edge address rather than the visitor, so visitors bucket by edge node
instead of individually and the limiter stops being per visitor. With two
hops the address logic has to count in from the right rather than take one; the comment on
`clientAddress` in `server/src/ws/server.ts` says so.

So behind a proxy, set both:

```
TRUST_PROXY=1
```

Without it, every client looks like the proxy. The per IP rate limits (including the room code
brute force guard) then apply to all of them collectively, and the concurrent connection cap of
12 applies to the whole service at once: the thirteenth simultaneous visitor is refused at the
WebSocket upgrade. Six rooms, service wide. The server logs a warning naming this exact situation
when it sees a forwarded header in production without `TRUST_PROXY` set.

Do NOT set it when the server is exposed directly, which includes running `docker-compose` with
its port mapping and no proxy in front.

## 3. Set ORIGIN to your real public origin

In production the `ORIGIN` allowlist is the entire CSRF defense on the WebSocket upgrade. The
development relaxation that accepts any localhost origin does **not** apply when
`NODE_ENV=production`.

```
ORIGIN=https://chat.example.com
```

Getting this wrong produces a 403 on the upgrade and a client that never connects.

## 4. Without TURN, roughly 10 to 15 percent of calls have no media

STUN alone cannot traverse symmetric NAT or a corporate firewall. Those calls will connect the
WebSocket, show the transcript, and never show video or hear audio.

The app degrades honestly here rather than appearing broken: transcripts ride the WebSocket, not a
data channel, so the call keeps working as text and the UI says the media connection failed. But
that is a fallback, not a fix.

Options, cheapest first:

- **metered.ca** has a free tier that is plenty for personal use. Check their dashboard for the
  current allowance.
- **Cloudflare Realtime** offers TURN.
- **Self hosted coturn** if you would rather run it:

```bash
docker run -d --network=host coturn/coturn \
  -n --lt-cred-mech --fingerprint \
  --realm=chat.example.com \
  --user=chatuser:CHANGE_THIS
```

Then:

```
TURN_URL=turn:turn.example.com:3478
TURN_USERNAME=chatuser
TURN_CREDENTIAL=CHANGE_THIS
```

All three variables, or none. The server REFUSES TO START on a partial set, naming every
variable that is missing. This is not pedantry: a `TURN_URL` with no credentials used to produce
an ICE entry the browser accepted and could not use, because a relay allocation without
credentials is rejected by every TURN server. The calls TURN was bought to carry still failed,
and the boot log said `STUN and TURN` while they did.

Boot logs say `ICE servers: 2 (STUN and TURN)` when it is wired up, and warn when it is not.

### metered.ca specifically

Take the URLs from the dashboard's **Show ICE Servers Array** button. That is the authoritative
list, and it is worth reading rather than guessing, for a reason that caught us:

**The relay host and the API host are different, and only one of them goes in `TURN_URL`.** The
dashboard also shows a REST example built on a per account subdomain like
`<yourapp>.metered.live`. That is the credentials API, NOT the relay. The relay is a shared host,
`global.relay.metered.ca` at the time of writing. Putting the account subdomain in `TURN_URL`
gives a host that does not answer as a TURN server.

The array lists several. Take the **`turns:`** line on 443, not the plain `turn:` one beside it:
the array offers both, and only the `turns:` one wraps the relay in TLS. That wrapper is what
carries it through a restrictive corporate network, because the connection then looks like an
ordinary TLS connection to anything filtering on port numbers. Plain `turn:` on 443 is
unencrypted TURN riding an HTTPS port, which clears a port filter and is obvious to anything
inspecting traffic. Neither survives a proxy that requires HTTP CONNECT or terminates TLS itself.
Port 80 and the UDP variants are faster when they work. If you only pick one:

```
TURN_URL=turns:global.relay.metered.ca:443?transport=tcp
TURN_USERNAME=<from the dashboard>
TURN_CREDENTIAL=<from the dashboard>
```

The dashboard also offers a REST API and an `apiKey` that mints short lived credentials at
runtime. The static trio is the right choice here, but be clear about what it costs rather than
thinking it is free.

**The TURN username and credential reach every participant, by design.** The browser is what
allocates the relay, so the server composes the ICE array at boot (`server/src/config.ts`) and
sends it to each client (`server/src/ws/server.ts`). Anyone who joins a room can read the pair
out of devtools, and it stays valid until you rotate it by hand on the dashboard.

**Rotating is two steps, and the gap between them is silent.** This server reads its config once
at boot, so a new credential on the dashboard changes nothing about what a running container
hands out: update `TURN_CREDENTIAL` in `.env` and restart as well. In between, the server serves
a dead credential, TURN stops carrying the calls it exists for, and the boot log goes on saying
`ICE servers: 2 (STUN and TURN)` throughout, because that line counts configuration rather than
testing it. Short lived
credentials exist precisely to bound that. What they cost is either an `apiKey` in the client
bundle, which is strictly worse, or a proxy endpoint on this server, which is modest work the
server is already shaped for.

So: static for an invite only two person app, where the people who can read the credential are
signed in people you invited, and the worst case is relay traffic on your quota until you rotate.
Revisit it if signup is ever opened (`SIGNUP_MODE=open`).

The array also offers `stun:stun.relay.metered.ca:80`. There is no need for it: this app already
configures a STUN server, and `TURN_URL` is only about the relay.

Check the current free allowance on their dashboard rather than trusting a number written here.
What matters for sizing: only the 10 to 15 percent of calls that cannot go peer to peer are
relayed at all, and a relayed call is on the order of 1 GB per hour per direction at HD, so two
people testing are not close to any plan's limit.

## 5. Mount the spend ledger as a volume

`out/translatv/spend_log.jsonl` is the source of truth for what this project has cost, and
the cap gate reads it **from disk** before every paid call rather than trusting an in memory
counter. That is what makes a restart unable to reset the day's spend to zero.

If the ledger lives only inside the container, every deploy resets it, and the daily cap resets
with it. The compose file mounts `./out` for exactly this reason. Keep that mount.

Note the deliberate failure direction: if the ledger is **unreadable**, the gate REFUSES to spend
rather than assuming zero. An unreadable ledger means spend to date is unknown, which is not the
same fact as nothing spent, and only one of those is safe to act on.

**Unwritable** is treated the same way, and it has to be: a ledger that cannot be appended to still
exists and still parses, so the gate would go on reading a stale file and allowing calls. The
server probes for this at boot and disables translation when it fails, and a run of failed writes
mid flight stops it too.

The server also **refuses to start** in production when the ledger is on the image layer rather
than a mount, because a restart there silently resets the day's spend and re arms a cap meant to
be cumulative. Mounting `./out` satisfies it. If your host genuinely keeps the ledger on the root
device and that is intended, set `ALLOW_EPHEMERAL_LEDGER=1` to say so deliberately.

The database gets the same treatment. `DATA_DIR` (default `data/`, which is `/app/data` in the
image) holds `translatv.db`, and the compose file mounts `./data` over it. Without that mount a
redeploy deletes every account, so the server **refuses to start** in production when the data
directory is on the image layer, printing `the database is on the image layer`. If that is
genuinely intended, set `ALLOW_EPHEMERAL_DATA=1`.

Both mounted directories have to be writable by the container's user, `node`, which is uid 1000.
`out/` and `data/` are both in the repository, so a clone made by a uid 1000 account already has
them with the right owner. A directory that does not exist when `docker compose up` runs is created
by the Docker daemon as **root** instead, and the server then refuses to start with `the database
could not be opened` (or, for the ledger, `production requires a writable ledger`). On a host where
the checkout belongs to a different account, hand both directories over once:

```bash
sudo chown -R 1000:1000 out data
```

## 6. Accounts: set AUTH_SECRET, or the server will not start

Every call needs a signed in account. Accounts live in the SQLite database (section 5), and a
session is two tokens: a 15 minute access token signed with `AUTH_SECRET`, and a 30 day refresh
token that is stored only as a hash and rotated on every use.

```
AUTH_SECRET=<the output of: openssl rand -hex 32>
```

In production the server **refuses to start** without it, the same way it refuses on an ephemeral
ledger, printing `refusing to start: AUTH_SECRET is not set`. A secret under 32 characters is
refused too (`AUTH_SECRET is too short`). In development an unset secret is replaced by a random
one per process, with a warning; restarting then signs everyone out.

Changing `AUTH_SECRET` invalidates every access token at once. Refresh tokens survive it, so
signed in browsers quietly get a new access token on their next refresh. To end every session
outright, delete the rows in `refresh_tokens` as well.

**Signup.** `SIGNUP_MODE=invite` (the default) needs a single use invite code, valid for 7 days.
`SIGNUP_MODE=open` lets anyone who can reach the server make an account, and with it spend
against the shared daily cap, so leave it on invite unless you mean that.

**The first account.** On a fresh invite only server nobody is signed in to ask for an invite, so
mint the first one from a shell on the machine that holds the database:

```bash
docker compose exec app node server/dist/cli/invite.js         # in the container
npm run invite                                                 # from a checkout
```

It prints the code and nothing else stores it: only a hash reaches the database.

**The owner.** `OWNER_EMAIL=<your email>` makes the account with that address the owner, re
checked on every boot. The owner can mint invites from the app (`POST /api/invites`). Nothing else
about the owner is special yet.

The rules it buys you:

- Any signed in account can start a call, bounded by the per account and per address limits and
  by the spend caps. The creator is the room's host.
- Joining needs an account too. A guest can join only while the host is in that room; a code
  with no live room behind it is answered the same way, so guessing codes teaches nothing.
- The host leaving ends the call. A dropped connection inside the reconnect grace window does
  not, so a wifi hop will not kill a conversation.
- Ten failed logins for one email lock that email for 15 minutes, whether or not it has an
  account, so the lock cannot be used to find out which addresses do.
- Native clients (the iOS app) connect with `Authorization: Bearer <access token>` and no Origin
  header. A browser sends its token as a WebSocket subprotocol instead, and its Origin must still
  match `ORIGIN` exactly: a valid token does not get a page on another site past that check.

## 7. Cloudflare Tunnel, end to end

This is the recommended shape: the container runs on a small VPS, Cloudflare Tunnel connects out
to Cloudflare, and nothing inbound is ever opened. No public IP, no port forwarding, no
certificate to renew, and the origin cannot be reached except through the tunnel.

**Cloudflare Workers cannot run this app.** Workers have no filesystem for the spend ledger, `ws`
needs a Node socket rather than the Workers WebSocket API, and both peers' sockets must land in
the same isolate, which means Durable Objects. Running on Workers is a port, not a deploy.

### On the VPS

```bash
curl -fsSL https://get.docker.com | sh
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

cloudflared tunnel login
cloudflared tunnel create translatv
cloudflared tunnel route dns translatv chat.example.com
```

`tunnel create` prints a tunnel ID and writes a credentials JSON under `~/.cloudflared/`. Both are
needed below.

### The tunnel config

`~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel ID from tunnel create>
credentials-file: /root/.cloudflared/<tunnel ID>.json

ingress:
  - hostname: chat.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

No `originRequest` tuning is needed. Cloudflare Tunnel proxies WebSockets with no configuration,
and the app pings every 20 to 30 seconds from both ends (`client/src/net/socket.ts` at 20s,
`server/src/ws/server.ts` at 30s), which keeps an idle call alive on its own.

Then:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### The app's own variables

`TRUST_PROXY=1` is REQUIRED here. The tunnel is a proxy, so without it every visitor arrives
wearing the tunnel's address and every per IP limit applies to all of them collectively. Section 2
explains which end of `X-Forwarded-For` is read and why this is exactly one hop.

```
ORIGIN=https://chat.example.com
TRUST_PROXY=1
```

### The port is bound to loopback, and must stay that way

The tunnel reaches the container over loopback, so the published port must not be on a public
interface. `docker-compose.yml` binds `127.0.0.1` by default for exactly this reason. Behind a
tunnel a public bind is the hole section 2 warns about: with `TRUST_PROXY=1` on, anyone who
reaches port 8080 directly bypasses the tunnel AND gets to forge `X-Forwarded-For`, which defeats
every per IP limit including the room code brute force guard.

**Do not try to change this from a second compose file.** `ports` is one of Compose's additive
options, so an override file APPENDS a second mapping and the public one survives alongside it.
That was the recipe written here first, and it did nothing. Use `BIND_ADDR` instead:

```
BIND_ADDR=0.0.0.0    # only for a LAN test on a network you trust, never behind the tunnel
```

Verify from another machine. This must fail:

```bash
curl http://<vps ip>:8080/healthz
```

while `https://chat.example.com/healthz` works. If the direct one answers, the tunnel is
decoration.

### Persist the ledger

The compose file mounts `./out` already. Keep that mount. Section 5 explains why a production
server refuses to start without it, and an ephemeral container filesystem is precisely the case
that guard exists for.

### On the Cloudflare dashboard

- The DNS record is created by `tunnel route dns` and is proxied (orange cloud) by definition.
  A tunnel has no origin IP to expose, so there is nothing to grey out.
- WebSockets are on by default. Confirm under Network if a call connects but never gets media.
- Rate limiting rules on `/api/auth` are worth adding at the edge as well. The server limits
  signup, login and refresh per address and locks an account after repeated failed logins, but
  an edge rule stops a flood before it reaches the container at all.

### Verify

```bash
curl https://chat.example.com/healthz
# {"ok":true,"translation":"enabled"}
```

Then open the page in a browser. `getUserMedia` requires HTTPS, which the tunnel provides, so a
camera prompt appearing at all confirms the TLS path end to end.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `8080` | `0` binds any free port; the real one is in the listening log line. |
| `ORIGIN` | **in production** | localhost dev origins | Comma separated. The CSRF defense. |
| `ANTHROPIC_API_KEY` | no | none | Without it translation is off and the app says so. Never prefix with `VITE_`. |
| `ANTHROPIC_DAILY_CAP_USD` | no | `10.00` | Hard ceiling. On breach, translation degrades and the call continues. |
| `ROOM_CAP_USD` | no | `1.50` | About three hours of continuous conversation. |
| `USER_DAILY_CAP_USD` | no | `1.00` | Per account, per UTC day, charged to the room's host. All three caps must pass, so it only tightens. |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | no | none | See section 4. |
| `AUTH_SECRET` | **in production** | random per process in development | Signs every access token. At least 32 characters; `openssl rand -hex 32`. The server REFUSES TO START in production without it. See section 6. |
| `SIGNUP_MODE` | no | `invite` | `invite` or `open`. Anything else is refused at boot. See section 6. |
| `OWNER_EMAIL` | no | none | The account with this email is the owner and can mint invites from the app. See section 6. |
| `TRUST_PROXY` | **behind a proxy** | off | `1` reads the client address from the NEAREST hop of `X-Forwarded-For`. Required with a reverse proxy, dangerous without one. See section 2. |
| `BIND_ADDR` | no | `127.0.0.1` | Which interface `docker-compose` publishes 8080 on. Loopback by default. `0.0.0.0` only on a trusted LAN, never behind a tunnel. See section 7. |
| `ALLOW_EPHEMERAL_LEDGER` | no | off | `1` permits the spend ledger to live on the image layer instead of a mounted volume. See section 5. |
| `DATA_DIR` | no | `data/` under the repo root | Directory holding the SQLite database `translatv.db`. Relative paths resolve against the repo root. Mount a volume here in production. See section 5. |
| `ALLOW_EPHEMERAL_DATA` | no | off | `1` permits the database to live on the image layer instead of a mounted volume. See section 5. |

## What running costs

Roughly **$0.50 per hour of conversation** at about 8 translated turns per minute, on Claude Haiku
4.5 at $1 and $5 per million tokens.

The obvious optimization does not work here and should not be attempted: Haiku 4.5's minimum
cacheable prefix is 4096 tokens and our system prompt plus glossary is about 500, so prompt caching
silently does not engage, reports `cache_creation_input_tokens: 0`, and delivers no benefit.
Padding the prompt to force it would cost more than it saves at these volumes.

Check what you have actually spent at any time:

```bash
python3 spend_log.py totals translatv
```

## Verifying a deployment

```bash
curl https://chat.example.com/healthz
# {"ok":true,"translation":"enabled"}
```

Then open the app in two browsers on two different networks (a phone on cellular is the useful
test, since it exercises the NAT traversal a second laptop on the same wifi does not), create a
room in one, and join with the code in the other.
