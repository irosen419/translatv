# Translatv

Realtime translated video calls. Two person rooms, WebRTC peer to peer media, and live translated
subtitles: the translation large on top, the original small and italic beneath it. English and
Spanish for the MVP, with regional dialect support, so an Argentine speaker reads voseo rather than
textbook Spanish.

Status: **working MVP**. Create a room, share the code, talk. 281 unit and integration tests plus
a 36 check two browser end to end run, and CI builds the Docker image and curls its health check
on every push.

Two things are built but **not yet verified against reality**, each because this build environment
physically cannot, and each stated here rather than left implied:

| What | Why not verified here |
|---|---|
| Translation quality | No API key has ever been used, so nobody has confirmed the real model produces voseo for `es-AR` |
| Acoustic echo, real transcription | The container has no audio hardware at all, and echo cannot be simulated |

The Docker image used to be on that list and no longer is. CI now builds it and confirms it
answers `/healthz`, which caught a real bug: `shared/package.json` pointed at TypeScript source,
which `tsx` loads in dev and plain `node` cannot, so the image died on boot every time while every
local run passed. Only `docker compose up` on a machine with a daemon is still unverified.

Translatv began as a copy of the private video-translation project on 2026-09-27. Step ids such
as `vt-0004` in code comments refer to that project's history. `docs/PLAN.md` is the plan for
accounts, per user spend and the iOS app.

```bash
npm install
npm run build
npm start          # http://localhost:8080
```

`TESTING.md` walks through getting this running on a laptop and checking it by hand, including
what a single machine can and cannot prove.

## Why spend tracking came first

Untracked spend was a real problem on a sibling project. Nothing in this repo can spend before
tracking exists, so the ledger is commit one rather than a later addition.

`out/translatv/spend_log.jsonl` is the append only source of truth. Two implementations
read it: `server/src/spend/ledger.ts` writes it live during calls, and `spend_log.py` is a standard
library only CLI for reading it. A shared fixture proves the two agree, and the dashboard's Ruby
reader consumes the same file.

```bash
python3 spend_log.py totals translatv   # what has this cost
python3 spend_log.py render --execute           # regenerate the human readable view
```

A missing ledger **raises**. It does not read as zero. "No ledger" and "spent nothing" are
different facts, and a gate that confuses them buys exactly the calls the cap existed to prevent.

## Before this project appears on the dashboard

The cockpit derives its project list from brain cards, **not** from anything in this repo. Nothing
here will make the project show up on the board on its own.

Create `~/second-brain/projects/translatv.md` with frontmatter carrying `name`, `status`,
`path`, and `tags`. The tags must **not** include `books`, so `ModeResolver` gives it the software
mode set (`propose-only`, `auto-PR`, `draft`, `documentation`) rather than the book one.

That is the only manual step. Everything else here already matches the cockpit's contract.

## To turn translation on

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. That is the only step.

Without it the app is still fully usable: the call connects, subtitles show in the original
language, chat works, and every line is marked "not translated" with a retry button rather than
sitting blank or spinning forever. The boot log says so plainly.

**Nobody has verified real translation output yet.** The entire pipeline is tested against an
injected fake client, which is what keeps the test suite free and offline, but it also means no
test has ever confirmed the real model produces voseo for `es-AR`. `npm run verify` is
that check, and it takes about two minutes by hand once a key is in place.

### When it deliberately does not translate

Three cases, none of which costs an API call, and all of which are decided BEFORE a line is
created so no rate limit token is taken and nothing announces a translation that is not coming:

- **You both speak the same language.** Compared by base language, so `en-US` with `en-GB`, or
  `es-AR` with `es-MX`, translates nothing. The in call control says "No translation needed" and
  is disabled, rather than pretending to be a choice.
- **You turned translation off**, with the control in the call footer. It is per person and
  applies to what you READ: the other person's words stop being translated for you, and yours are
  still translated for them. Neither of you can switch it off for the other. They see a chip
  saying you did, because otherwise their own lines quietly stop showing a translation and the
  app looks broken.
- **Nobody else is in the room yet.** Talking to yourself is not translated.

The original text always still appears, and none of these render as a failure or offer a retry
button: nothing was attempted, so there is nothing to retry.

## The speech spike

`script/probe_speech_api.mjs` settled the question that decided the speech architecture, and it is
re-runnable on any browser build:

```bash
node script/probe_speech_api.mjs
```

Verdict, from Chrome 141: `SpeechRecognition.start()` **does** accept a `MediaStreamTrack`, so
recognition receives the same echo cancelled track WebRTC is sending and the echo problem is
designed away rather than mitigated. These findings come from the original project's spike (its step vt-0001).

`script/spike.html` covers what a container physically cannot: real transcription, acoustic echo
(sound leaving a speaker and re-entering a mic cannot be simulated), and session durability. Serve
it over https or from localhost and follow the tests on the page.

## Development

```bash
npm run dev        # server on 8080, client on 5173 with hot reload
npm run check      # dashes, copy parity, typecheck, all tests
npm run e2e        # two real browsers through the whole flow
```

The end to end run is the one that proves the app works rather than that its parts do. It drives
two Chromium contexts through create, join, WebRTC negotiation, the transcript pipeline, capacity
refusal, leaving, and ending. It uses text chat rather than speech because the fake media device
emits a tone rather than a voice, and text goes through the identical server path.

Copy `.env.example` to `.env` and fill in `ANTHROPIC_API_KEY`. Never rename it with a `VITE_`
prefix: Vite inlines every `VITE_*` variable into the client bundle, which would publish the key to
every visitor. `npm run check:secrets` greps the built client for exactly that mistake.

## Known limitations, stated up front

- **Firefox has no Web Speech API.** The call will work there; subtitles will not. The app detects
  this and says so rather than breaking.
- **On the cloud speech path, audio goes to the browser vendor** (Google for Chrome). Chrome 139+
  supports genuinely on device recognition via `processLocally`, and where that is available the
  caveat does not apply at all.
- **WebRTC peer to peer fails for roughly 10 to 15 percent of network pairs.** A TURN relay fixes
  it. Because transcripts ride the WebSocket rather than a data channel, a call whose media fails
  still works as text, which is a real degraded mode rather than a failure.
- **Rooms are in memory only.** A server restart destroys every room. That is the design, not a
  bug, and the UI says so.
