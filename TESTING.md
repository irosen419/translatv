# Testing this by hand

How to get this running on your own machine and see it work, rather than trusting the test suite.

Everything here except the last two sections is free and offline. You do not need an API key: the
app is fully usable without one, and says so plainly at boot.

## What you need

| Thing | Why |
|---|---|
| **Node 20 or newer** | The only hard requirement to RUN the app. Check with `node --version`. |
| **Chrome** | Subtitles use the Web Speech API. **Firefox does not have it at all**, so the call and typed chat work there but subtitles never appear. |
| **Python 3** | ONLY for the Python test suite and the spend CLI. Not needed to run the app. |

No compiler, no native dependencies, nothing to install globally beyond Node.

## Setup

```bash
npm install
npm run check
```

`npm run check` runs the dash check, the copy parity check, the typecheck, and every
test. It spends nothing and touches no network. **If it passes, the machine is set up
correctly** and anything that goes wrong after this is the app, not the install.

## Running it

**Development, with hot reload:**

```bash
npm run dev          # server on 8080, client on http://localhost:5173
```

Vite proxies `/ws` and `/healthz` through to the server, so the WebSocket origin check behaves in
development exactly as it does in production.

> **On Windows `npm run dev` does not work as written.** The script backgrounds the server with
> `&`, which is a POSIX shell operator; `cmd.exe` reads it as "run these in sequence", so the
> server starts and the client never does. Use two terminals:
> `npm run dev --workspace=server` in one, `npm run dev --workspace=client` in the other.

**Production shape**, one process serving the built client:

```bash
npm run build
npm start            # http://localhost:8080
```

Both URLs are in the default allowed origins, so neither needs configuration.

Without a key the boot log says:

```
ANTHROPIC_API_KEY is NOT set: translation is DISABLED.
  The call, the transcript, and the original language subtitles all still work.
```

That is a documented degraded mode, not an error.

## The manual test

Open **two tabs** in Chrome. Two tabs is enough: the resume token lives in `sessionStorage`, which
is per tab, so they behave as genuinely separate participants.

> **Type rather than talk**, at least at first. The "Type a message" box goes through the
> identical server path (the automated end to end run uses text for exactly this reason), and it
> avoids two tabs on one machine feeding audio into each other. To talk, wear headphones or mute
> one tab.

Tab A: "Start a new chat", name yourself Ana, pick a language, create, copy the 8 character code.
Tab B: paste the code, "Join chat", name yourself Ben, pick a language, join.

### 1. Same language means no translation, and the control says so

Give the two tabs the **same base language** but different regions, for example Ana
`English (United States)` and Ben `English (United Kingdom)`.

- The control in the footer reads **"No translation needed"** and is **disabled**.
- A typed message appears once, with no "translating..." and no "not translated" marker.

Different regions of one language never cost an API call. Same for `es-AR` with `es-MX`.

### 2. The translation off switch

Change Ben's language to `Espanol (Argentina)`. Ana's control becomes active, reading
**"Translation off"**.

- Click it in Ana's tab.
- **Ben's tab shows a chip reading "they turned translation off".** That chip is load bearing:
  translation results are broadcast to both people, so without it Ben's own lines quietly stop
  showing a translation and the app looks broken.
- A message from Ben arrives in Ana's transcript resolved immediately, shown once.
- Clicking again ("Translation on") clears the chip.

The switch is per person and applies to what you READ. Ana turning it off stops Ben's words being
translated for Ana, and leaves Ana's words being translated for Ben. Neither can switch it off for
the other.

### 3. Mute reaches the other person

**Mute** in Ana's tab puts a **"they are muted"** chip in Ben's. Muting also stops speech
recognition, so a muted person is not still being transcribed.

### 4. Camera off and back on

- **Camera off** in Ana's tab. Ben sees a placeholder reading "Ana turned their camera off",
  rather than a frozen frame.
- **Camera on** again. **The video comes back.**

That last step is the real test. The video element is mounted conditionally, so coming back means
a fresh element, and its stream has to be reattached. When that did not happen the video returned
permanently black with nothing logged anywhere. Watch the small self view in Ana's own tab too:
the same bug affected it.

Someone who joined without a camera at all gets different wording ("joined without a camera"),
because that is a different situation from one that is temporarily off.

### 5. Prove the API calls are really not happening

```bash
python3 spend_log.py totals translatv
```

Run it before and after everything above. **It must not move.** That file is the append only
source of truth, so a call that happened would be in it. A fresh clone reads
`known spend $0.000000 across 0 calls`.

## Turning translation on for real, about 3 cents

```bash
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env`. **Never rename it with a `VITE_` prefix**: Vite inlines every
`VITE_*` variable into the public client bundle, which would ship the key to every visitor.
`npm run check:secrets` greps the built bundle for exactly that mistake.

Caps ship at `$10.00` per day and `$1.50` per room, both checked against the ledger rather than an
in memory counter, so a restart cannot reset the day.

```bash
npm run verify
```

Refuses to run without a key and never prints it. One cheap smoke call first, then a dialect
matrix scored on falsifiable markers (`es-AR` must produce `tenes` and never `tienes`, `es-ES`
must produce `vosotros`, `es-CO` must produce `usted`), then glossary adherence, ledger
arithmetic, reader agreement between the Python and TypeScript implementations, and cap
enforcement.

Then restart the server and redo tests 1 and 2 with translation genuinely on. The spend total
should climb for the cross language lines and **stay flat** for the same language and translation
off ones. That is the direct proof rather than the test suite's proof.

## The browser end to end suite

```bash
npx playwright install chromium
npm run e2e
```

Two Chromium contexts through the whole flow, 36 checks, including the camera off and back on
assertion. It hard overrides the API key to empty in the spawned server, so it never spends even
once a key is configured.

## What a single machine cannot test

Acoustic echo: sound leaving a speaker and re-entering a microphone cannot be simulated, and two
tabs on one machine share the same speaker and mic. That needs two machines, and
`getUserMedia` refuses to run on a plain `http://192.168.x.x` address because it is not a secure
context, so it also needs locally trusted certificates (`mkcert`) and `ORIGIN` updated to the
https LAN address. `certs/` and `*.pem` are gitignored for this.

`script/spike.html` is a standalone page for the echo and transcription questions and needs no
server at all. Serve it over https or from localhost and follow the tests on the page.

## If something goes wrong

- **`EADDRINUSE`**: something else holds 8080 or 5173. `PORT=8081 npm start`, or kill the stray
  process. Changing the port locally is safe even though the allowed origins list names 5173 and
  8080: outside production, ANY localhost origin is accepted regardless of port, precisely so that
  an ordinary port clash does not turn into a confusing 403. That relaxation does not apply when
  `NODE_ENV=production` (the Docker image sets it), where `ORIGIN` must name the real origin
  because the allowlist is the whole CSRF defense for a cookie-less WebSocket app.
- **Errors from vite or tsx at startup**: check `node --version` is 20 or newer.
- **"translation is not configured on this server"**: expected without a key.
- **No subtitles**: check you are in Chrome.
- **Media never connects**: there is no TURN server configured, and roughly 10 to 15 percent of
  real network pairs fail peer to peer without one. Transcripts and chat still work in that case,
  by design. Between two tabs on one machine this should not happen.
