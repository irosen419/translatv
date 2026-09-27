# Translatv: implementation plan

Written 2026-09-27 in a cloud planning session, first for the video-translation repository and
then moved here when the owner made Translatv its own project (one public repository holding the
server, the shared protocol, the web client and the iOS app). This file stands alone: the coding session that
carries it out will have this repository and nothing else, so every rule, recipe and measured
fact it needs is copied in here. Where a fact was measured, the plan says when and how, because
several of the obvious assumptions turned out false when probed (see "Measured in the planning
session").

Scope is code. Developer accounts, fees and store listings are assumed and appear only where a
run genuinely needs them, as named pre-flight items.

## Contents

1. Decisions
2. Architecture
3. Milestones
4. The one-shot
5. Owner pre-flight
6. After the one-shot
7. Risks and spikes
8. Coding session kickoff prompt
9. Android notes

Appendices: A. Execution lanes. B. Cloud recipe. C. Interface acceptance standards. D. Rules
that bind the whole repository. E. Measured in the planning session.

---

## 1. Decisions

Each decision gives the choice, why, and what evidence would change it. The owner already
decided: iOS first and Android after, multi-user is required, Translatv is its own project with
its own server (seeded from video-translation), everything lives in this ONE public repository,
and coding runs in cloud sessions wherever possible. Those are not reopened here.

### D1. Stack: native SwiftUI

- **Choice.** SwiftUI app, Swift 6 language mode, plain MV with `@Observable` models and
  dependencies injected at `init` (the Holdfast architecture: no TCA, no Combine in new code, no
  singletons).
- **Why.** The hard part of this product is the native audio path (one echo cancelled microphone
  feeding both WebRTC and speech recognition). Every stack, React Native included, would have to
  write that part natively, and React Native would add a bridge over exactly the code that is
  riskiest. SwiftUI keeps the risky code and the UI in one language and one debugger.
- **What would change it.** Nothing short of Android being promoted ahead of iOS.

### D2. CI runner, Xcode and Swift: `macos-26`, Xcode 26.6, Swift 6.3

- **Choice.** GitHub hosted `macos-26` (arm64), with Xcode 26.6 selected explicitly
  (`sudo xcode-select -s /Applications/Xcode_26.6.app`), never the image default. The Linux
  toolchain is the Docker image `swift:6.3` (Swift 6.3.3, measured). Milestone M8 asserts on
  every macOS run that `xcrun swift --version` reports the same major and minor as the
  `.swift-version` file the Docker commands read, so the two cannot drift silently.
- **Why.** Read from `actions/runner-images` at commit ede07f8 (2026-09-25):
  - `macos-26` is also the `macos-latest` label. Image 20260907.0351.1 runs macOS 26.6.2.
  - It ships Xcode 26.0.1 through 26.6, with **26.6 the default**. It has iOS SDKs 26.0 to 26.5, and simulator runtimes 26.2, 26.4 and 26.5 with iPhone 17 devices.
  - `macos-15` defaults to Xcode 16.4 (iOS 18.5 SDK) and carries Xcode 26.0.1 to 26.3 only as extras.

  holdfast-ios pinned to Xcode 16.4 because "until `macos-26` images exist with stable Xcode 26,
  anything that requires Swift 6.2 features is locked out" (its MEMORY.md, 2026-05-27). That
  condition is now met. Holdfast's other toolchain lesson still binds: local and cloud tooling
  match CI, never the reverse, and no code uses an API newer than the CI SDK (iOS 26.5).
- **Swift version is an expectation, verified by M8.** The runner image docs do not state the
  Swift version inside Xcode 26.6. The expectation is 6.3 (Xcode 26.4 onward). If M8 reports
  otherwise, `.swift-version` and the Docker tag change together in one commit. `swift:6.2`,
  `6.3` and `6.4` all exist on Docker Hub (checked 2026-09-27).
- **What would change it.** The runner image moving its default, or Xcode 26.6 being removed.
  In both cases the pin is changed on purpose, never picked up implicitly.

### D3. Minimum iOS: 26.0

- **Choice.** Deployment target iOS 26.0.
- **Why.** The owner's default was iOS 18 "unless the CI runner offers a stable Xcode 26 and
  `SpeechAnalyzer` wins the speech decision". The first condition is now true (D2). For the
  second, this product is a long running call that transcribes continuously, which is exactly
  what `SpeechAnalyzer` with `SpeechTranscriber` is built for: long form, on device, with no
  per request duration limit. The older `SFSpeechRecognizer` limits duration on server based
  recognition, and its on device mode varies by locale. iOS 26 also runs on every iPhone from
  the iPhone 11 onward.
- **What would change it.** Milestone M15's locale probe, or device testing (D lane), might show
  that `SpeechTranscriber` cannot serve the six dialects while `SFSpeechRecognizer` can on iOS 18.
  Then the target drops to 18.0. The speech adapter boundary (D6) makes that a contained change.

### D4. WebRTC framework: `livekit/webrtc-xcframework`, used directly

- **Choice.** Depend on `https://github.com/livekit/webrtc-xcframework` at the exact version the
  LiveKit Swift SDK pins (150.7871.02 as of 2026-09-22), and use its `LKRTC*` classes directly.
  Do NOT use the LiveKit Swift SDK: that SDK needs a LiveKit server (an SFU), and this product is
  peer to peer with its own signaling.
- **Why.** It is the one prebuilt WebRTC with a supported hook for the top risk (D5). Read from
  the LiveKit Swift SDK source (`Sources/LiveKit/Core/RTC.swift`,
  `Sources/LiveKit/Audio/Manager/AudioManager.swift`, `Sources/LiveKit/Audio/AudioEngineObserver.swift`):
  - the factory is built as `LKRTCPeerConnectionFactory(audioDeviceModuleType:bypassVoiceProcessing:...audioProcessingModule:)`;
  - the audio device module can run on `AVAudioEngine` (`LKRTCAudioDeviceModuleType.audioEngine`) with voice processing controls;
  - `LKRTCDefaultAudioProcessingModule` exposes a `capturePostProcessingDelegate`, which receives the microphone buffers AFTER WebRTC's audio processing (echo cancellation included). The SDK's own "local audio renderer" is built on it.
  - an engine observer can reconfigure the input node graph (`engineWillConnectInput`).

  stasel/WebRTC is a plain Google build without these hooks.
- **What would change it.** Evidence from M14 or M16 that the framework's Objective C headers
  do not expose these types outside the LiveKit SDK. The fallback is to vendor the SDK's small
  adapter files (Apache 2.0) that wrap them.

### D5. One microphone, two consumers: tap WebRTC's processed capture

- **Choice.** WebRTC owns capture through its `AVAudioEngine` audio device module with voice
  processing on. Speech recognition is fed from `capturePostProcessingDelegate`, so it hears the
  same echo cancelled audio the peer hears. This is the iOS equivalent of the web's vt-0001
  design, where `SpeechRecognition.start(track)` takes the very track WebRTC sends.
- **How the buffers flow.** The delegate runs on the realtime audio thread. It must only copy
  into a lock free ring buffer and return. A consumer task drains the ring, converts the audio
  with `AVAudioConverter` to the analyzer's best available format, and yields it into the
  `SpeechAnalyzer` input stream. Frame accumulation, dropped frame counting and backpressure are
  pure logic in the core package (M11). Only the conversion and the delegate are Apple only
  (M16).
- **What would change it.** A device test (D lane) where the far party's voice shows up in the
  local transcript with the speaker on. Next option is design 1 from the brief: an input graph
  of our own through `engineWillConnectInput`. Last resort is two captures with headphones
  advised. Only a phone can answer this, which is why the device harness (M19) exists.

### D6. Speech API: `SpeechTranscriber`, with `SFSpeechRecognizer` as a second adapter

- **Choice.** An `SttAdapter` protocol in the core package mirrors `client/src/stt/types.ts`:
  - `onInterim(text)`, `onFinal(text)` and `onStatus(status)`;
  - status is one of idle, listening(onDevice), downloading(language), reconnecting(attempt), blocked(reason, notice) or failed(notice);
  - capabilities are `supported`, `onDeviceAvailable` and `notice`.

  Two Apple adapters implement it:
  - `AnalyzerSttAdapter` (primary): `SpeechAnalyzer` and `SpeechTranscriber`, using volatile results for interims and final results for finals, with asset download mapped to the `downloading` status.
  - `LegacySttAdapter`: `SFSpeechRecognizer` with `requiresOnDeviceRecognition` where the locale supports it.

  The adapter is chosen per dialect at runtime, from the locale support each engine reports.
- **Why.** The web contract already separates engine from consumers, so porting it keeps the
  swap cheap. Locale support is a runtime answer on iOS, so it is read at runtime, not guessed.
- **What would change it.** M15's probe of supported locales on the simulator, and device testing
  by dialect.

### D7. Protocol in Swift: hand written `Codable`, verified by fixtures on every build

- **Choice.** This repository gains a generated JSON Schema and a golden fixture file for every
  wire message (M1), under `shared/wire/`. The iOS test target reads them IN PLACE from that
  directory, so there is no copy to drift. The Swift `Codable` types must decode and re-encode every fixture byte for byte after
  normalization. A completeness test fails if any message `t` in the fixture index has no Swift
  case.
- **Why.** Generating Swift from JSON Schema adds a tool (quicktype or similar) whose output
  still needs hand shaping into enums with associated values. A hand copy that nothing checks is
  forbidden. A hand copy that 30 fixtures check on Linux in seconds is not a hand copy that
  nothing checks.
- **Prerequisite.** Today only the client to server messages are zod schemas. `ServerMessage`
  (`shared/src/protocol.ts` L335 to L418) is a plain TypeScript union, which the schema
  generator cannot see. M1 converts it to zod first and derives the type with `z.infer`, which
  also brings it in line with this repository's own rule that the zod schemas are the single
  source of truth.
- **What would change it.** The protocol growing past roughly 50 message types, where generation
  would start paying for itself.

### D8. Copy on iOS: bundle the web catalogs and port the fallback chain

- **Choice.** The iOS app bundles `en.json`, `es.json`, `es-AR.json`, `es-CO.json` and
  `es-ES.json` straight from `client/src/i18n/` (a build phase copies them into the app bundle,
  so the web client and the app read the same files). The core package ports
  `copy.ts`: exact dialect, then base language, then English, with the same interpolation. Only
  the system permission prompts (`NSMicrophoneUsageDescription`, `NSCameraUsageDescription`,
  `NSSpeechRecognitionUsageDescription`) live in an `InfoPlist.xcstrings` String Catalog, because
  iOS reads those itself.
- **Why this departs from the brief.** The brief suggested porting the catalogs into a String
  Catalog. A String Catalog follows the DEVICE locale, but this product's UI dialect is the
  user's choice in the app and can differ from the device (an Argentine user with an English
  phone). The web's override chain also has thin dialect files (es-AR has 48 keys over es's 183),
  which lproj fallback can express only for the device locale. Porting the chain keeps the two
  clients in agreement, and the core package can test it on Linux.
- **One source of copy.** iOS only keys are added to the web catalogs in THIS repository, so
  `npm run check:copy` covers them.
- **What would change it.** A decision that the app's UI language always follows the device.

### D9. Accounts and persistence

- **Store.** SQLite through Node's built in `node:sqlite` (`DatabaseSync`), with no native
  dependency. Measured working on Node 22.22.2 in the planning container, with an experimental
  warning. Node 20 reached end of life in April 2026, so the server moves to **Node 22 LTS**:
  - `engines` becomes ">=22.13";
  - the Dockerfile moves to `node:22-alpine`;
  - CI moves to Node 22.

  Rooms stay in memory.
- **Auth.**
  - Email and password. Passwords are hashed with scrypt from `node:crypto`, the same primitive `adminAuth.ts` already uses.
  - Access tokens are short lived (15 minutes), HMAC signed with the same construction as `mintAdminToken`.
  - Refresh tokens are opaque random values stored hashed, and rotated on every use. A reused refresh token revokes its whole family.
  - Sign in with Apple comes later.
- **Signup is invite only by default** (`SIGNUP_MODE=invite|open`). The owner mints invites with
  `npm run invite` or from an owner only endpoint. Why: the global daily cap is shared, so open
  signup would let a stranger spend the owner's money down to the cap. Open signup is one
  setting away when the owner wants it.
- **Who can start and join a call.** Any signed in account can start one, bounded by the per
  user cap. Joining also requires signing in. A guest joining by link without an account is
  deferred: it needs a spend attribution story first.
- **Who pays.** Translation spend is attributed to the room's creator, the host.
- **The owner.** `OWNER_EMAIL` marks one account as owner, and the owner is who mints invites.
  `ADMIN_PASSWORD` and the admin token are retired, and the production boot guard that refuses to
  start without an admin password becomes one that refuses to start without `AUTH_SECRET`.
- **Native clients and the Origin check.** In production today, a WebSocket upgrade with no
  Origin header is refused (`server/src/ws/server.ts` L242 to L263), and a native client sends
  none. The rule becomes: an upgrade with no Origin is accepted ONLY when it carries a valid
  access token in `Authorization: Bearer`. Browser upgrades keep the Origin allowlist, because
  that is their CSRF defense. Measured: a Swift WebSocket client sends `Authorization` on the
  upgrade and no Origin (Appendix E).
- **What would change it.** `node:sqlite` misbehaving under load or in Alpine: switch to
  `better-sqlite3` behind the same store interface.

### D10. Per user spend

- **Choice.**
  - Ledger rows gain `user_id`: an opaque random id, never an email or username.
  - `caps.ts` gains a per user daily cap (`USER_DAILY_CAP_USD`, default 1.0) beside the existing global daily cap and per room cap. A call is translated only if ALL three pass, so a per user cap can never loosen the others.
  - `spend_log.py` reads and reports the field. The shared fixture gains rows with and without it, and both readers still agree.
- **Account deletion and the ledger.** The ledger is append only and is never edited. Its rows
  carry only the opaque id, which becomes unlinkable once the account row is deleted.
- **The dashboard.** The project-dashboard Ruby reader (`app/services/spend_row.rb`) reads
  named fields and passes the whole record through (`record.merge(...)`), so it accepts the new
  field unchanged. Showing spend per user there would be a separate, optional change in that
  repository.

### D11. Project file: XcodeGen

- **Choice.** `project.yml` with a pinned XcodeGen version, generated in CI and on the owner's
  Mac. `*.xcodeproj` is git ignored and never committed, so no agent can hand edit
  `project.pbxproj`.
- **Why not Holdfast's synchronized folders.** They still need a committed pbxproj that someone
  created in Xcode, and new targets or build phases need a human in Xcode. XcodeGen lets an agent
  add a target by editing YAML that is reviewable in a diff.
- **How it is installed.** XcodeGen is NOT preinstalled on `macos-26`, per the runner readme.
  CI downloads a pinned release zip from GitHub and verifies its sha256.
- **What would change it.** XcodeGen failing to express something the app needs (it covers app
  extensions and entitlements, so this is unlikely for the MVP).

### D12. macOS CI minutes: the repository is public

- **Choice.** `irosen419/translatv` is PUBLIC (done, 2026-09-27), where standard GitHub hosted runners
  (`macos-26` included) are free.
- **Why.** macOS minutes bill at ten times the Linux rate on private repositories, and this
  account has exhausted its Actions quota before (awws, August 2026, when every run failed in
  about three seconds without executing). The one-shot's C2 milestones total an estimated 250
  to 400 macOS minutes (per milestone figures in section 3), which is 2,500 to 4,000 billed
  minutes on a private repository. The repository holds no secret by rule (Appendix D): keys,
  the auth secret and TURN credentials live in environment settings, so public costs nothing in
  exposure. Server and app share the repository, so the macOS job uses path filters and runs only
  when `ios/`, `shared/wire/`, the copy catalogs or the workflow change.
- **If it ever goes private.** Set an Actions spending cap first, and treat "quota exhausted" as a
  hard stop (section 4).
- **Budget measures kept anyway.** Path filters, one simulator, no matrix, SwiftPM and
  DerivedData caches, a concurrency group cancelling superseded runs, and `timeout-minutes` on
  every job.

### D13. Foreground only MVP

- **Choice.** No CallKit, no background audio, no push invites in the MVP. A call ends
  gracefully when the app backgrounds, using the server's existing 60 second grace to resume if
  the user returns.
- **Why.** CallKit and push need owner owned capabilities (push certificates, entitlements) and
  device testing. They are sequenced after the MVP works.

### D14. Merging

- **Server pull requests (M1 to M6).** The run opens them and never merges. They change auth,
  storage and the server's security boundary, and M6 is a spend change, which CLAUDE.md holds for
  the owner regardless of review.
- **iOS pull requests (M7 onward), touching only `ios/` and CI.** The run merges its own once every
  required check is green, with an ordinary merge commit (not squash), matching the owner's
  convention. Never on red or pending, and never one that touches `server/`, `shared/` or the spend
  files: those go back to the owner.

---

## 2. Architecture

### Data flow in a call

```
 iPhone A                                   server (this repo)                      iPhone B
 ─────────                                  ──────────────────                      ─────────
 mic ─► WebRTC ADM (voice processing) ──────── media, peer to peer (never via server) ───────►
          │
          └► capturePostProcessingDelegate
               └► ring buffer ─► AVAudioConverter ─► SpeechAnalyzer (A's dialect)
                                                   │ interim/final text
 SignalingClient ◄──── WebSocket /ws (Bearer) ────►│ RoomSession ─► TranslationService
   stt.interim / stt.final / chat / rtc.* ────────►│   (spend gate: global, room, user)
   ◄── transcript.final / translation.result ──────│ ─► ledger row (user_id) ─► Haiku 4.5
```

Everything the server promises today still holds:
- it never sees audio or video;
- each device transcribes only its own microphone;
- the translation key never leaves the server;
- every paid call goes through the ledger and all caps first.

### Server changes (`server/`, `shared/`, `client/`)

| Area | Change | Paths |
|---|---|---|
| Wire | `ServerMessage` to zod. JSON Schema export and golden fixtures. `PROTOCOL_VERSION` on `/healthz` | `shared/src/protocol.ts`, `shared/wire/`, `script/check_wire.mjs` |
| Runtime | Node 22 LTS | `package.json`, `Dockerfile`, `.github/workflows/ci.yml` |
| Store | SQLite store with migrations, and a boot guard against an ephemeral database in production | `server/src/store/` |
| Auth | Signup (invite), login, refresh, logout, account deletion. Bearer on HTTP and on the WebSocket upgrade. Per account lockout | `server/src/auth/`, `server/src/http.ts`, `server/src/ws/server.ts` |
| Limits | Buckets keyed by user as well as IP | `server/src/security/rateLimit.ts` |
| User data | Dialect preference, glossaries, call history, contacts derived from history | `server/src/store/`, `server/src/http.ts` |
| Spend | `user_id` on rows, per user daily cap | `server/src/spend/`, `spend_log.py`, `test_fixtures/` |
| Web client | Account sign in replaces the admin password. e2e covers two accounts | `client/src/`, `script/e2e.mjs` |
| Copy | iOS only keys added to the web catalogs | `client/src/i18n/*.json` |
| Logger | `email`, `password`, `token`, `refreshToken` added to `FORBIDDEN_KEYS` | `server/src/log.ts` |

### The iOS app (`ios/` in this repository)

```
ios/
  AGENTS.md  CODING_STANDARDS.md  GUARDRAILS.md  MEMORY.md
  project.yml                     XcodeGen spec (app, unit tests, UI tests)
  .swift-version                  "6.3", read by the Docker commands and asserted in CI
  Packages/TranslatvCore/         platform free Swift package, tested on Linux AND macOS
    Sources/TranslatvCore/
      Wire/        Codable client and server messages, dialects
      Net/         SignalingClient state machine over a SocketTransport protocol
      Room/        RoomStore reducer (port of client/src/state/store.ts apply)
      RTC/         perfect negotiation state machine over an RtcEngine protocol
      Speech/      SttAdapter contract, audio frame ring and accumulator
      Captions/    ports of client/src/lib caption, chips, code, composer
      Copy/        catalog loader and fallback chain (port of copy.ts)
      Auth/        token lifecycle and refresh state machine over an HttpTransport protocol
    Tests/TranslatvCoreTests/     unit tests; reads ../../../shared/wire/fixtures in place
    Tests/TranslatvIntegrationTests/  Linux only: the real server from server/, websocket-kit client
  App/
    TranslatvApp.swift
    Platform/      URLSessionSocketTransport, URLSessionHttpTransport, Keychain
    RTC/           LKRTC adapter implementing RtcEngine
    Speech/        AnalyzerSttAdapter, LegacySttAdapter, CaptureTap (delegate plus converter)
    UI/            Theme, SignIn, PreJoin, Room, Settings, DeviceHarness (debug only)
    Resources/     InfoPlist.xcstrings (the copy JSON is copied in from client/src/i18n at build)
  AppTests/  AppUITests/
  scripts/         ci-linux.sh, check_secrets.sh, check_logging.sh, integration.sh
.github/workflows/ios.yml         jobs: ios-linux, ios (required checks), path filtered
```

The repository's own CLAUDE.md stays the single contract; `ios/AGENTS.md` adds only the Swift
specific rules. The existing `npm run check:dashes` already scans every tracked file, Swift
included, so the dash rule needs no second script.

Why the core package carries so much: it is the only Swift code a cloud session can compile
and test without spending macOS minutes. Views stay thin over models, models call core types,
and the Apple only folders hold nothing but adapters to protocols defined in the core.

Visual language to carry over, from `client/src/styles.css`, which is dark only:
- colors: `--bg #0b0d10`, `--panel #14181d`, `--line #262c34`, `--text #e8ecf1`, `--muted #97a3b2`, teal accent `--accent #5eead4`, `--warn #ffc978`, `--danger #ff8f85`;
- system fonts only, and a monospace for room codes;
- the translated line large at weight 600, the original small and italic beneath it, over a black gradient scrim;
- fade out 600ms, fade in instant, reduced motion respected.

On a phone the translated line is the thing the user came for, so it carries the most weight on
the room screen.

---

## 3. Milestones

Every milestone has one lane (Appendix A) and one check the session can run or read itself.
Stated macOS minutes are estimates for the C2 milestones: expected runs times minutes per run,
with the first run cold and later runs cached. M8 replaces them with measured figures in
`MEMORY.md`.

Branching:
- **Server.** Milestones M1 to M5 go on one working branch, and M6 (spend) goes on a branch stacked on it. That makes two pull requests, both left for the owner.
- **iOS.** One branch and one pull request per milestone, cut from `main` once the server pull requests are merged, and merged by the run on green (D14).

### Server (`server/`, `shared/`, `client/`)

**M1. Wire export and golden fixtures** (C1)
- **Goal.**
  - Convert `ServerMessage` to zod and export types with `z.infer`, keeping existing names so consumers compile unchanged.
  - Add `zod-to-json-schema` (pinned) and generate `shared/wire/schema.json`.
  - Write one fixture per message type in `shared/wire/fixtures/{client,server}/<t>.json`, plus `index.json`.
  - Add `PROTOCOL_VERSION` to `shared` and to `/healthz`.
  - Add `script/check_wire.mjs`: every fixture parses with its schema, every union member has a fixture, and the committed schema equals a fresh generation. Add it to `npm run check`.
- **Paths.** `shared/src/protocol.ts`, `shared/wire/`, `script/check_wire.mjs`, `package.json`.
- **Check.** `npm run check` exits 0, and `node script/check_wire.mjs` fails when one fixture is deleted (proved once in the test suite, not left to trust).
- **Depends on.** Nothing.

**M2. Node 22 and the SQLite store** (C1)
- **Goal.**
  - Move to Node 22 LTS (D9).
  - Add `server/src/store/` on `node:sqlite` with numbered migrations, a repository interface per table, and an in memory database for tests.
  - Add a production boot guard mirroring the ledger guard: refuse to start when the database file is on the image layer, unless `ALLOW_EPHEMERAL_DATA=1`.
- **Check.** `npm run check` exits 0. The docker CI steps pass locally in the session: build, health check, and a new "refuses to start on an ephemeral database" step, which asserts on the refusal reason like the existing steps do.
- **Depends on.** Nothing.

**M3. Accounts, tokens and the WebSocket gate** (C1)
- **Goal.**
  - Build signup (invite), login, refresh with rotation and reuse detection, logout and `whoami` under `/api/auth`.
  - Add per account lockout, `npm run invite` and `OWNER_EMAIL`.
  - `room.create` and `room.join` require a user (in place of `adminToken`).
  - Native upgrades authenticate with `Authorization: Bearer` (D9 Origin rule).
  - Add buckets per user beside the IP buckets.
  - Add the new logger forbidden keys.
- **Paths.** `server/src/auth/`, `server/src/http.ts`, `server/src/ws/server.ts`, `server/src/security/rateLimit.ts`, `server/src/log.ts`, `shared/src/protocol.ts`, and fixtures regenerated.
- **Check.** `npm run check` exits 0, with new tests proving four things:
  - an upgrade with no Origin and no bearer is refused in production;
  - an upgrade with no Origin and a valid bearer is accepted;
  - a reused refresh token revokes its family;
  - the logger withholds `email`.
- **Depends on.** M1 and M2.

**M4. The web client on accounts** (C1)
- **Goal.** Sign in and invite screens replace the admin password. Retire `ADMIN_PASSWORD`,
  `adminSession.ts` and the admin boot guard, which is replaced by an `AUTH_SECRET` guard with a
  docker step asserting its reason. `script/e2e.mjs` creates two accounts through the API and
  runs its existing 36 checks.
- **Check.** `npm run check && npm run e2e` exit 0, and the docker steps pass locally.
- **Depends on.** M3.

**M5. Per user data and account deletion** (C1)
- **Goal.**
  - Store dialect preference, glossaries (a user's glossary is merged into a room's glossary when they create or join), call history (room code hash, peer user id, start, end) and contacts (derived from call history).
  - Add `DELETE /api/account`, with password re-authentication, which deletes the user's rows and revokes their tokens.
  - Transcripts are NOT persisted server side: storage follows the spirit of the logging rule.
- **Check.** `npm run check` exits 0, including a test that after deletion no table holds the user id and login fails.
- **Depends on.** M3.

**M6. Per user spend** (C1; its pull request is HELD for the owner)
- **Goal.** D10: `user_id` on ledger rows, a per user daily cap requiring all three caps to
  pass, `spend_log.py` support, and shared fixture rows with and without the field, with both
  readers asserted to agree.
- **Paths.** `server/src/spend/`, `spend_log.py`, `test_spend_log.py`, `test_fixtures/ledger_root/`.
- **Check.** `npm run check` exits 0 (both suites run inside it).
- **Depends on.** M3.
- **No real spend.** Tests use the existing fakes (`fakeClient`, `echoClient`, `refusingAppend`), and nothing calls the Anthropic API.

### iOS (`ios/`)

**M7. Scaffold and the Linux gate** (C1)
- **Goal.** Under `ios/`:
  - Write the harness files (AGENTS.md, CODING_STANDARDS.md, GUARDRAILS.md, MEMORY.md), carrying Appendices C and D. The root CLAUDE.md gains one line pointing at `ios/AGENTS.md`.
  - Add `project.yml`, an empty `TranslatvCore`, and `.swift-version`.
  - Point the core tests at `shared/wire/fixtures` in place, and the app's copy build phase at `client/src/i18n/`.
  - Add scripts: `check_secrets.sh` (key prefixes such as `sk-ant-` in tracked files and build settings), and `check_logging.sh`. The logging check fails on any `Logger`, `os_log` or `print` call that interpolates a value named like text, transcript, username, glossary or email.
  - Add `scripts/ci-linux.sh` running all of those plus `swift test` in Docker.
  - Add a CI `ios-linux` job running the same script, path filtered like the macOS job.
- **Check.** `ios/scripts/ci-linux.sh` exits 0 in the session, and the `ios-linux` check is green on the pushed commit.
- **Depends on.** M1 merged.

**M8. The macOS toolchain oracle** (C2)
- **Goal.**
  - Add an `ios` job on `macos-26` that selects Xcode 26.6 and prints `xcodebuild -version`, `xcrun swift --version` and the simulator runtimes.
  - Fail if the Swift major and minor differ from `.swift-version`.
  - Install pinned XcodeGen, generate the project, build the empty app, and run `TranslatvCore` tests and the app's unit tests on one simulator (`iPhone 17`, iOS 26.5).
  - Carry over Holdfast's CI lessons: `set -o pipefail` with the log teed to a file, `-skipPackagePluginValidation`, and the result bundle uploaded on failure.
  - Add a concurrency group, path filters (`ios/`, `shared/wire/`, `client/src/i18n/`, the workflow) and SwiftPM plus DerivedData caches.
- **Check.** The `ios` check is green, and MEMORY.md records the measured Xcode, Swift, runtime and minutes.
- **Depends on.** M7.
- **Estimated macOS minutes.** 3 runs, about 12 cold and 6 warm: 25.

**M9. Wire types** (C1)
- **Goal.** `TranslatvCore/Wire`: every client and server message as `Codable` enums, dialects from `languages.ts`, error and close codes. Fixture round trip plus the completeness test (D7).
- **Check.** `ios/scripts/ci-linux.sh` exits 0, and the `ios-linux` check is green.
- **Depends on.** M7.

**M10. Signaling, room store and auth logic** (C1)
- **Goal.**
  - `SignalingClient` ports `client/src/net/socket.ts`: backoff at 250ms times 2 to the attempt, capped at 8s, plus jitter; `room.resume` on open; resume credentials rotated on every created or joined message; closes 4000, 4001 and 4002 terminal; an app ping every 20s.
  - It runs over a `SocketTransport` protocol with a scripted fake.
  - `RoomStore` ports the reducer.
  - `Auth` ports the token refresh state machine.
- **Check.**
  - `ios/scripts/ci-linux.sh` exits 0.
  - `ios/scripts/integration.sh` exits 0. It builds and starts this repository's own server (no Anthropic key, so translation reports `not_configured`), then two Swift clients on `websocket-kit` sign up, create and join a room, exchange `stt.final` and chat, and assert `transcript.final` on both sides.
- **Depends on.** M3 and M9.

**M11. Captions, chips, codes, composer, copy and the audio ring** (C1)
- **Goal.**
  - Port `client/src/lib/caption.ts`, `chips.ts`, `code.ts` and `composer.ts` with their test cases.
  - Port `copy.ts`, and mirror `copy.test.ts`'s register assertions (voseo for es-AR, vosotros for es-ES, usted for es-CO).
  - Build the lock free frame ring and accumulator for D5, with dropped frame counting.
  - Port the perfect negotiation state machine from `client/src/rtc/PeerConnection.ts` over an `RtcEngine` protocol:
    - the polite peer yields;
    - the impolite peer ignores colliding offers;
    - on disconnected, wait a 3s grace, then recover;
    - only the impolite peer restarts ICE, at most 3 times.
- **Check.** `ios/scripts/ci-linux.sh` exits 0.
- **Depends on.** M9.

**M12. Longest locale, measured** (C1)
- **Goal.** A script computes, per catalog, the rendered length of every key after fallback,
  and records which locale is longest overall and which is longest per key. The result drives
  M18's fit tests (the owner's standard: Spanish runs 25 to 30 percent longer, so expect `es-CO`
  or `es`, but measure it).
- **Check.** The script exits 0 and writes `Tests/longest-locale.json`, which a unit test asserts is present and current.
- **Depends on.** M11.

**M13. Apple transports and Keychain** (C2)
- **Goal.** `URLSessionSocketTransport` (with `Authorization: Bearer` on the upgrade) and
  `URLSessionHttpTransport` implementing the core protocols, plus a thin Keychain wrapper for the
  refresh token and the resume token (the access token stays in memory). Unit tests run against
  the protocols. The Keychain tests run in the simulator.
- **Check.** The `ios` check is green.
- **Depends on.** M8 and M10.
- **Estimated macOS minutes.** 4 runs at 7: 30.

**M14. WebRTC adapter** (C2)
- **Goal.** Add `webrtc-xcframework` at the exact pinned version. `LKRTCEngine` implements
  `RtcEngine`. A simulator test connects two in process peer connections through a loopback
  signaling fake and asserts both reach `connected` over a data channel. Media is not tested:
  the simulator has no camera. Confirm and record in MEMORY.md that `LKRTCDefaultAudioProcessingModule` and its
  `capturePostProcessingDelegate` are visible from Swift (D4's evidence).
- **Check.** The `ios` check is green, including the loopback test.
- **Depends on.** M11 and M13.
- **Estimated macOS minutes.** 6 runs at 10 (a larger download on the cold run): 60.

**M15. Speech adapters and the locale probe** (C2)
- **Goal.**
  - Build `AnalyzerSttAdapter` and `LegacySttAdapter`.
  - Unit tests drive each adapter's state mapping through fakes of the engine's result stream.
  - A probe test writes, for each of the six dialects: whether `SpeechTranscriber` supports it, whether it is installed, and whether `SFSpeechRecognizer` supports it on device. It uploads that as a CI artifact that the session reads back.
  - A second simulator test synthesizes a Spanish phrase with `AVSpeechSynthesizer` to a file and runs it through the analyzer if assets are available. Otherwise it records "assets unavailable in simulator" without failing. This probe informs, it does not gate: the gate is the unit tests.
- **Check.** The `ios` check is green, and the probe artifact is recorded in MEMORY.md.
- **Depends on.** M8 and M11.
- **Estimated macOS minutes.** 5 runs at 8: 40.

**M16. The capture tap** (C2)
- **Goal.** `CaptureTap` installs as `capturePostProcessingDelegate`, copies into the M11 ring,
  and converts to the analyzer format with `AVAudioConverter`. Simulator tests feed synthetic
  buffers through the delegate entry point and assert the converted frames and the drop counter.
- **Check.** The `ios` check is green.
- **Depends on.** M14 and M15.
- **Estimated macOS minutes.** 4 runs at 8: 32.

**M17. Screens against a fake server** (C2)
- **Goal.**
  - Build `Theme` (the tokens in section 2), then sign in, invite, pre-join (dialect picker, camera and mic toggles), room (remote video, self view, subtitle overlay with the translated line dominant, transcript panel, chat composer, translation toggle and chips, glossary correction) and settings (UI dialect, account deletion).
  - A `-uiTestFake` launch argument swaps in scripted core fakes.
  - UI tests drive sign in, create, join, captions arriving, chat, glossary correction and deletion.
- **Check.** The `ios` check is green, including the UI tests.
- **Depends on.** M13 and M11.
- **Estimated macOS minutes.** 8 runs at 10: 80.

**M18. Interface acceptance** (C2)
- **Goal.** Make Appendix C executable. For every screen, in the longest locale from M12, at
  `.accessibility5`, in dark mode:
  - `XCUIApplication().performAccessibilityAudit()` passes (labels, contrast, hit regions, Dynamic Type);
  - a fit test finds no truncated primary label: for each element in a registry of primary label identifiers, it measures the string with the element's text style at that size and width, and asserts the required height fits the element's frame;
  - a lint rejects fixed `.frame(height:)` on `Text` and `.lineLimit(1)` on a primary label;
  - snapshots of every screen at the largest size, with a capital diacritics sample ("ÁÉÍÓÚÑ"), are uploaded as an artifact for the owner to review.
- **Check.** The `ios` check is green, including the audit and fit tests.
- **Depends on.** M17 and M12.
- **Estimated macOS minutes.** 5 runs at 10: 50.

**M19. Device harness** (C2)
- **Goal.** A debug only screen for the device lane. It shows:
  - live interim and final text from the capture tap;
  - which adapter and locale are active, and whether recognition runs on device;
  - the drop counter;
  - a "play a known phrase through the speaker" button, for the echo test: the phrase must NOT appear in the local transcript.

  It is compiled out of release builds.
- **Check.** The `ios` check is green, and a UI test reaches the harness in debug with fakes.
- **Depends on.** M16 and M17.
- **Estimated macOS minutes.** 3 runs at 8: 24.

**Estimated macOS total for the one-shot.** About 341 minutes, before retries. Free on a public
repository. On a private one, roughly 3,400 billed minutes (D12).

### After the stop point (not in the one-shot)

| # | Lane | Work |
|---|---|---|
| M20 | O | Apple Developer team and signing for device installs; a bundle id. |
| M21 | L | First device build from the owner's Mac: generate the project, set the team, run on an iPhone. Fix whatever signing surfaces. |
| M22 | D | Permission flows (mic, camera, speech) in English and Spanish. |
| M23 | D | Echo: the M19 harness with the speaker on. This settles D5. |
| M24 | D | Recognition by dialect: es-AR against es-MX, en-GB against en-US. The iOS counterpart of vt-0013. This settles D3 and D6. |
| M25 | O | A TURN service and its three variables on the server (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`). |
| M26 | D | A real two phone call on Wi-Fi, then on cellular through TURN. |
| M27 | D | Battery and heat over a 30 minute call. |
| M28 | O | Anthropic key for real translation quality checks (vt-0005), under the ledger and caps. |
| M29 | O | Deploy the server with accounts. Mint invites. |
| M30 | C2 | CallKit, push invites and universal links, after the MVP holds on devices. |

---

## 4. The one-shot

The work runs in two stages, because the iOS branches are cut from a `main` that already carries
the server changes, and only the owner merges those.

```
Stage 1 (running in the planning session, 2026-09-27):
M1 ─► M2 ─► M3 ─► M4 ─► M5 ─► M6          (server; C1 only)   STOP: two PRs for the owner

Stage 2 (one unattended cloud session, after the owner merges stage 1):
M7 ─► M8 ─► M9 ─► M10 ─► M11 ─► M12
   ─► M13 ─► M14 ─► M15 ─► M16 ─► M17 ─► M18 ─► M19   STOP
```

Server first, because M10's integration test needs M3, and because the server milestones spend no
macOS minutes.

**Before each stage.**
- Install `resume-after-limit` (a scheduled hourly resume whose prompt rebuilds state from the
  branches, pull requests and check runs, and is silent when there is nothing to do).
- Keep `STATUS.md` on the working branch, naming the last green milestone and the next one.

**Loops.** Use `handoff-loop` for any milestone whose check is "a CI job is green", with a
10 round cap: M8, M13, M14, M15, M16, M17 and M18. Each round is one fix and one push, and the
orchestrator reads the job log back through the GitHub tools.

**Commit and push at every green milestone.** The container is reclaimed when the session ends.

**Stage 1 stop point.** Two open pull requests: M1 to M5, and M6 (spend) stacked on it. Both are
green and unmerged.

**Stage 2 stop point.** M19 green on `main`. The run then:
- leaves `main` green on `ios-linux` and `ios`, with every iOS milestone pull request merged;
- leaves `ios/MEMORY.md` updated with the measured toolchain, minutes and locale probe;
- writes a final `STATUS.md` with the stop reason and the after-the-one-shot list from section 6.

**Hard stops.** Each writes `STATUS.md` with the reason and the last green milestone, pushes,
and ends the run cleanly.
1. An owner action is needed (a pre-flight item turns out not done, a permission is refused).
2. Only a device can answer: the next step depends on a D lane result.
3. CI quota exhausted. Runs fail in seconds without executing any step (the awws signature:
   dead runs took about 3 seconds, real failures about a minute), or the account reports a
   spending limit.
4. A house rule would be broken: a dash, a secret, text in a log, or an unledgered call.
5. A step would spend money: an Anthropic call, a paid runner size, a TURN provider signup.
6. A push would need force, or `git pull --rebase` meets a conflict it cannot resolve without
   dropping someone's work. On a ledger conflict keep both sides, always.

---

## 5. Owner pre-flight

| # | Item | Done when |
|---|---|---|
| P1 | Create `irosen419/translatv`, PUBLIC (D12), with the Claude GitHub App installed. An agent cannot do this: the GitHub integration refused `create_repository` with "Resource not accessible by integration" (measured 2026-09-27). | DONE 2026-09-27. |
| P2 | Merge the stage 1 pull requests (section 6, step 1). | `main` carries M1 to M6. Stage 2 needs this. |
| P3 | Add `.claude/settings.json` to `main`, declaring the `ian` plugin exactly as project-dashboard does: `"extraKnownMarketplaces": {"custom-plugins": {"source": {"source": "github", "repo": "irosen419/claude-plugins"}}}` and `"enabledPlugins": ["ian@custom-plugins"]`. It is an owner step because a coding session should not change its own repository's Claude settings. | A fresh cloud session on this repository lists `ian:resume-after-limit` and `ian:handoff-loop`. |
| P4 | Set the cloud environment's setup script to the recipe in Appendix B, and keep Docker Hub and GitHub reachable in its network policy. | A fresh session prints `Swift version 6.3` from `docker run --rm swift:6.3 swift --version`. |

Deliberately NOT pre-flight, because the run never needs them: an Anthropic key, signing, a
TURN server, Android SDK access. Each sits after the stop point.

---

## 6. After the one-shot

In order. "Who" is the owner unless stated.

1. **Review and merge the server pull request** (M1 to M5), then the spend pull request (M6),
   reconciling any stated spend against the ledger (there should be none: no call is made).
   About an hour. This also unblocks stage 2.
2. **Deploy the server** with the new variables: `AUTH_SECRET`, `OWNER_EMAIL`, `SIGNUP_MODE`,
   `USER_DAILY_CAP_USD`, and a volume for the database. Mint the first invites. About 30 minutes.
3. **Optional: put Translatv on the dashboard** with a brain card at
   `~/second-brain/projects/translatv.md` (tags must not include `books`). The dashboard reads the
   ledger by the slug `translatv`.
4. **M20 and M21.** Signing and the first device build on the Mac. About an hour, more if signing
   fights back.
5. **M22 to M24 on one phone.** Permissions, echo and dialect recognition. About 2 hours, and
   they settle D3, D5 and D6. If echo fails, a cloud session implements the D5 fallback and the
   owner re-tests.
6. **M25 and M26.** TURN, then a two phone call on Wi-Fi and on cellular. Half a day, including
   setting up TURN.
7. **M27.** A long call for battery and heat. An hour of calling.
8. **M28.** Real translation quality with a key, under the caps. Owner judged.
9. **M30.** CallKit and push, planned as a follow-up in the same shape as this plan.

---

## 7. Risks and spikes

| Risk | Settled by | Lane | Milestone |
|---|---|---|---|
| The processed capture still carries the far voice (echo in recognition) | Device harness with the speaker on | D | M23 (harness in M19) |
| `LKRTC` audio processing types are not visible outside the LiveKit SDK | Compile against them | C2 | M14 |
| `SpeechTranscriber` lacks one of the six dialect locales, or silently maps es-AR to another model | Locale probe, then device testing | C2, then D | M15, M24 |
| Swift in Xcode 26.6 is not 6.3 | Version assertion job | C2 | M8 |
| `URLSessionWebSocketTask` cannot run on Linux (MEASURED: it fails, see Appendix E) | Linux tests use `websocket-kit`. The URLSession transport is tested in the simulator | C1, C2 | M10, M13 |
| `node:sqlite` is experimental in Node 22 | Store tests and the docker guard steps. `better-sqlite3` behind the same interface if needed | C1 | M2 |
| Native clients refused by the Origin check | Bearer upgrade rule with tests both ways | C1 | M3 |
| Actions quota exhaustion | Public repository, budget measures, hard stop 3 | O, C2 | D12, M8 |
| Toolchain drift between the owner's Mac and CI | `.swift-version` assertion, and Xcode pinned explicitly | C2, L | M8, M21 |
| Truncated Spanish labels or clipped diacritics at large sizes | Audit, fit tests, snapshots reviewed | C2, O | M18 |
| TURN missing on cellular | TURN service, cellular call | O, D | M25, M26 |
| Invite only signup feels closed | `SIGNUP_MODE=open` is one variable, once per user caps are proven | O | after M29 |

---

## 8. Coding session kickoff prompt (stage 2)

Start a cloud session with `translatv` (push) attached, after P2 to P4 are done. Paste:

```
Carry out stage 2 of docs/PLAN.md (milestones M7 to M19) as described in its section 4.
Read the plan fully first, then CLAUDE.md. The plan is the task.

Before any milestone: run /ian:resume-after-limit so a usage limit cannot end the run silently,
then confirm the pre-flight in section 5 holds (P2 to P4) and hard stop if it does not.

Run M7 to M19 in order. Every milestone ends in its stated check; commit and push at every green
milestone. Use /ian:handoff-loop (10 round cap) for the milestones whose check is a CI job.
Merge your own iOS pull requests with a merge commit once every required check is green, but
never one that touches server/, shared/ or the spend files: leave those for the owner.

Obey the hard stops in section 4: on any of them write STATUS.md, push, and end the run. Never
spend money: no Anthropic call, no paid runner, no provider signup.
```

**Setup script:** Appendix B.

**Skills to install first:** `resume-after-limit`, then `handoff-loop` when the first C2 milestone
starts. Both come from the `ian` plugin (P3).

---

## 9. Android notes

- **What carries over.**
  - The server entirely: accounts, tokens, the bearer upgrade rule, per user spend.
  - The wire schema and fixtures (a Kotlin client verifies against the same files).
  - The copy catalogs and the fallback chain.
  - Every behavior spec the core package's tests encode: the backoff, resume and close semantics, perfect negotiation, captions and chips.
- **What does not.** Swift code. The audio design has to be redone for Android. Its WebRTC
  audio device module owns capture with its own acoustic echo canceller, and recognition would
  need the same processed capture. Android's `SpeechRecognizer` does not take an external audio
  source on most devices, so an on device model fed from WebRTC's processed audio is the likely
  path. That is Android's version of D5, and it needs its own spike.
- **Cloud environment.** `dl.google.com`, where the Android SDK lives, is refused by the current
  network policy (measured 2026-09-26). `maven.google.com`, Gradle and Maven Central are
  reachable. The Android phase needs `dl.google.com` allowlisted, and the CI oracle is an Ubuntu
  runner with the emulator, which costs Linux minutes rather than macOS.

---

## Appendix A. Execution lanes

| Lane | Meaning |
|---|---|
| C1 | Cloud, Linux. Written and verified inside the session container. No outside dependency. |
| C2 | Cloud plus hosted macOS CI. Written in the session, compiled and tested by a GitHub hosted macOS runner, read back by the session through the GitHub tools (workflow runs and job logs). Costs macOS minutes. |
| L | Local Mac. Needs interactive Xcode: capability toggles, signing problems, Instruments. |
| D | Device. Needs a physical iPhone: microphone, speaker echo, camera, cellular, push. |
| O | Owner. An account, secret, setting or approval only the owner holds. |

## Appendix B. Cloud recipe (measured)

Setup script for the environment:

```bash
if ! docker info >/dev/null 2>&1; then
  nohup dockerd >/tmp/dockerd.log 2>&1 &
  for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
docker pull -q swift:6.3
```

Run the same daemon check again before the first Docker command in a session: a daemon started
by a setup script is not guaranteed to outlive it.

Build and test a Swift package with the proxy and CA bundle passed through, so SwiftPM can fetch
GitHub dependencies. `NO_PROXY` keeps the integration tests' traffic to the local server off the
proxy:

```bash
docker run --rm --network host \
  -e HTTPS_PROXY="$HTTPS_PROXY" -e HTTP_PROXY="$HTTPS_PROXY" \
  -e https_proxy="$HTTPS_PROXY" -e http_proxy="$HTTPS_PROXY" \
  -e NO_PROXY=127.0.0.1,localhost -e no_proxy=127.0.0.1,localhost \
  -v /root/.ccr/ca-bundle.crt:/ca.crt:ro -e SSL_CERT_FILE=/ca.crt -e GIT_SSL_CAINFO=/ca.crt \
  -v "$PWD":/pkg -w /pkg swift:"$(cat .swift-version)" swift test
```

Other traps:
- On Linux, import `FoundationNetworking` under `#if canImport(FoundationNetworking)` for URLSession.
- Read GitHub through git or the GitHub tools. Plain `curl` against github.com web pages is refused.
- `download.swift.org` is blocked, and apt has no Swift for Ubuntu 24.04. Docker Hub is the only route.
- XcodeGen is not on the macOS runner. CI installs a pinned release.

## Appendix C. Interface acceptance standards (the owner's)

These are acceptance criteria, made checkable in M18:

- **Text expansion.** Spanish runs 25 to 30 percent longer than English. No primary label
  truncates, buttons grow with their text, and every screen is checked in the longest locale as
  measured by M12.
- **Diacritics never clip.** Capitals with accents (Á, É, Ñ) need line heights that fit them. No
  fixed heights on text and no negative line spacing. Checked at the largest Dynamic Type sizes.
- **Dynamic Type through the accessibility sizes, and VoiceOver labels on every control.**
  `performAccessibilityAudit()` passes on every screen.
- **Hierarchy follows the data.** In a call, the translated line carries the most weight. No
  generic card grids and no stock styling. Start from the web app's visual language (section 2).
- **Checks, not intentions.** Every rule here that can be tested is a test in M18.

## Appendix D. Rules that bind the whole repository

- **No em dashes or en dashes in any file**, Swift included. `npm run check:dashes` already
  scans every tracked file.
- **No secret in a repository or an app bundle.** This is the iOS form of the `VITE_` rule:
  `check_secrets.sh` scans tracked files and build settings for key prefixes. Secrets live in
  environment settings only.
- **Never log transcript text, chat text, usernames, emails or glossary content**, including
  through `Logger`, `os_log` and `print` in the app. The logger takes counts, identifiers and
  durations only.
- **Every paid call goes through the ledger first.** A per user cap never bypasses the global or
  per room caps. A missing ledger raises, an unknown cost is null and never zero, and money is
  rounded to 6 decimals.
- **Nothing automated arms an autopilot step.** Arming is owner only.
- **TDD:** red, then green, then refactor.
- **Git.**
  - Agent work goes on its own branch.
  - Run `git pull --rebase` before committing.
  - A push that would need force is a stop.
  - On a `spend_log.jsonl` conflict, keep both sides.
  - Never push server or spend changes straight to `main`: they go through a pull request the owner merges.
- **Swift, from Holdfast.**
  - No `!` force unwraps and no `try!` outside tests.
  - One type per file.
  - Error enums with one mapping point.
  - Networking only through the transport protocols.
  - Never hand edit a generated project.

## Appendix E. Measured in the planning session

Measured on 2026-09-27 in the planning container (Ubuntu 24.04, x86_64). Probes ran in a scratch
directory and nothing from them is committed.

| Probe | Result |
|---|---|
| `swift:6.3` image | Swift 6.3.3. Tags 6.1, 6.2, 6.3 and 6.4 all exist. |
| Core package on 6.3 (Codable enum with accented text, `@Observable` `@MainActor` store, Swift Testing) | Builds, 3 of 3 pass. |
| `URLSessionWebSocketTask` on Linux | Compiles, but FAILS at runtime: "WebSockets not supported by libcurl" (NSURLErrorDomain -1002). |
| `vapor/websocket-kit` client on Linux against a Node `ws` server | Passes. It sends `Authorization: Bearer` on the upgrade, and no Origin header. Round trips "Ñandú" intact. |
| `node:sqlite` on Node 22.22.2 | Works (in memory create, insert, select), with an experimental warning. |
| `actions/runner-images` at ede07f8 | `macos-26` = `macos-latest`, Xcode 26.6 default, iOS SDK 26.5, simulators 26.2 to 26.5. `macos-15` defaults to Xcode 16.4. No XcodeGen on either. |
| LiveKit Swift SDK source (2026-09-22) | Pins `webrtc-xcframework` 150.7871.02. Exposes `capturePostProcessingDelegate` on `LKRTCDefaultAudioProcessingModule`, an `AVAudioEngine` audio device module, and an engine observer with `engineWillConnectInput`. |
| project-dashboard `SpendRow` | Reads named ledger fields, passes the whole record through, and tolerates new fields. |
| Attaching a repository mid session | Widens read and push scope for that repository only. "account-wide tools such as `create_repository` remain limited to the repositories attached to this session." |
