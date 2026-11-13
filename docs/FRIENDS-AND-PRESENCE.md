# Friends and presence: scope

Written 2026-11-13 at the owner's request. Scoping only: nothing here is built yet. The plan of
record, `docs/PLAN.md`, carries the decisions (D15 to D17) and the milestones (M31 to M36) that
come from this file; this file is the longer reasoning behind them and the brief a coding session
works from.

Two features:

1. **A friends list.** People you choose to keep, so you can see them and call them without
   trading a room code.
2. **Appear online or offline.** Friends can see when you have the app open, and you can hide
   that.

They are scoped together because each makes the other useful. A friends list without presence
means ringing someone blind. Presence without friends has nobody to show it to. And in the
foreground only MVP (D13: no push, no CallKit), presence is what makes direct calling workable at
all: "online" means "a ring will reach them right now".

---

## 1. What exists today (PR #9 branch, 2026-11-13)

- **Calls start by code.** One person creates a room, shares the 8 character code or link, the
  other joins. Both must be signed in.
- **Accounts** have an email, a password and a `display_name`. There is no handle or username to
  search by, and signup is invite only, minted by the owner.
- **Recent calls and contacts.** `call_history` holds one row per participant per call (a room
  code hash, never the code). Contacts are DERIVED from it and never stored.
- **contactId.** Every person you have called appears to you under an opaque id, `contactIdFor(viewer,
  peer)` in `server/src/account/service.ts`. It is per viewer and stable, and it is never the
  peer's account id. The server resolves a contactId only among people the viewer has called,
  so a contactId lifted from someone else's screen names nobody.
- **Block and report** live on the account page under Recent calls, with a "Blocked people"
  list. A block is stored in the blocker's row and enforced both ways: two accounts with a block
  between them are never put in one room, and a live room holding both is separated.
- **The WebSocket exists only for rooms.** The client opens it to create, join or resume a room.
  There is no connection while someone sits on the home screen, so today the server cannot tell
  who has the app open.

## 2. Friends

### 2.1 What a friend is

A friendship is **mutual**: a request, then an accept. Not a one sided follow. Two reasons: the
app is a private calling tool, and both presence and direct ringing are things you should only
expose to someone you said yes to.

A friendship gives each side exactly three things, and nothing else:

1. The other person on your friends list, under their current display name.
2. Their presence (section 3), subject to their own visibility setting.
3. The ability to ring them directly (section 4).

It does NOT share email, account id, glossary, saved corrections, call history or anything said on
a call. Those rules from CLAUDE.md stand unchanged.

### 2.2 How you add someone

There is no search. Searching by email or name would let anyone with an account check whether an
address is registered, and would turn an invite only app into a directory. Two ways in instead:

- **From Recent calls** (v1). Each recent call row gains "Add friend" beside Block and Report.
  It sends a request to that contactId. This covers the main case: you met through a code, it
  went well, you want them back.
- **A personal friend link** (v1). Each account can show a link (and a QR code on iOS) that
  sends a request to them when someone signed in opens it. You share it however you like, in
  person or in a message. The link carries a random token, not an account id; it can be reset
  at any time, which kills the old one.

A friend link is NOT a signup invite. Someone without an account who opens it lands on the sign
in screen, and still needs an owner minted invite to sign up. Letting every user mint signup
invites would let anyone grow the user base against the shared spend cap, which is exactly why
signup is invite only (D9). Combining the two is a later, deliberate decision (section 7, idea 5).

### 2.3 Requests

- The recipient sees incoming requests at the top of the friends list, with **Accept**,
  **Decline** and **Block**.
- **Decline is silent.** The sender keeps seeing "Request sent" until it expires after 30 days.
  They are never told "declined", so declining someone costs nothing socially.
- **Crossed requests** (each sent one to the other) accept each other automatically.
- **Cancel.** A sender can withdraw a pending request.
- **Limits.** At most 20 pending outgoing requests per account, at most 10 new requests a day,
  and a declined pair cannot be re-requested by the same sender for 30 days. At most 500
  friends per account. These numbers are starting points, set as named constants in
  `shared/src/friends.ts` so the iOS app reads the same ones from `constants.json`.

### 2.4 Identity: one id per person, everywhere

The friends API reuses `contactId`, so a person has ONE opaque id in your app whether they
appear in Recent calls, Friends, a request, or Blocked people. The change is where the server
resolves it: today `peerFor` looks only through call history; it becomes call history, plus
friends, plus pending requests in either direction. A person who added you by link and never
called you still resolves, and a made up id still names nobody.

### 2.5 Friends and blocking

Blocking always wins, and it is silent.

| Situation | What happens |
| --- | --- |
| You block a friend | The friendship ends, for both sides, and so do pending requests either way. They see you vanish from their list (as if you unfriended), never "blocked". Your presence stops reaching them at once. |
| You block someone who sent you a request | The request is removed. |
| A blocked person sends you a request (from an old Recent call, or your friend link) | It is dropped. Their screen shows "Request sent" exactly as for anyone else, so the block cannot be detected by probing. |
| A blocked person rings you | Not possible: they are not your friend. Calling by code was already refused for blocked pairs. |
| You unblock someone | Nothing comes back. No friendship and no requests are restored; either of you can send a fresh request. |
| Block and Report from the friends list | Both are on every friend's row and on every request. App Review guideline 1.2 asks for blocking wherever users meet, and a friends list is such a place. |

### 2.6 Friends and Recent calls

- Recent calls stays the record of every call, friend or not.
- A recent call with a friend shows a small "Friend" marker; one without shows "Add friend".
- Calls placed by ringing (section 4) land in Recent calls like any other, including missed
  ones (section 4.4).
- The friends list sorts online friends first, then by most recent call, then by name.

### 2.7 Unfriend and account deletion

- **Unfriend** removes the friendship for both, silently, like a block without the block.
- **Account deletion** removes every friendship, request and friend link through ON DELETE
  CASCADE, in line with how `DELETE /api/account` works today. Nothing about friends needs to
  outlive either account, unlike reports.

### 2.8 Private nickname (v1, small)

Each person can give a friend a nickname that only they see ("Ana (Córdoba)"). Display names
change, and two friends can share one. It is stored on the viewer's side of the friendship and
never sent to the friend. It is a name, so it is never logged.

## 3. Presence and appearing offline

### 3.1 States

| State | Meaning | Who sees it |
| --- | --- | --- |
| **Online** | The app is open on at least one device (a web tab, or the iOS app in the foreground) | Accepted friends only |
| **In a call** | Online and currently in a room | Accepted friends only |
| **Offline** | Neither of the above, OR the person chose to appear offline | Everyone else sees nothing at all |

No "last seen". It leaks routine (when you sleep, when you are at work) for little gain, and
"online now" is all the ringing decision needs. It can be added later behind the same visibility
setting if people ask for it.

Presence is never shown to someone who is merely in your Recent calls, never to a pending
request, and never across a block.

### 3.2 Appear offline

A setting on the account page, "Show when I'm online", on by default, synced across devices
(stored server side with the other preferences). Off means every friend sees you as Offline on
every device.

**Appearing offline does not make you unreachable.** Friends can still ring you; you choose
whether to answer. That is the point of "appear" offline, and it keeps the setting's meaning
honest. Not wanting rings at all is a different setting, Do not disturb (section 7, idea 2).

**It must be undetectable.** A ring to someone who appears offline and does not answer has to
look exactly like a ring to someone truly offline: same wait, same "No answer" at the same
moment. The server therefore holds every ring for the full timeout, even when it already knows
nobody is connected, and never answers "offline" faster than "no answer".

**Not reciprocal.** Hiding yourself does not hide your friends from you. Reciprocity (as
WhatsApp does for last seen) adds a rule people have to learn, and with no "last seen" there is
little to trade. Revisit only if it is asked for.

### 3.3 What online honestly means

- **Web.** A signed in tab with the page open. Several tabs or devices count once.
- **iOS (foreground only MVP).** The app in the foreground. When it goes to the background it
  becomes Offline after the grace below, because without push or CallKit a ring could not reach it
  anyway.
- **Grace.** Going offline waits 20 seconds after the last connection closes, so a page reload,
  a network blip or switching apps briefly does not flash your friends' lists. Coming online is
  immediate.

### 3.4 How it works

- **A home connection.** The client opens the WebSocket whenever someone is signed in, not only
  in a room, and the same socket carries presence and rings. This is the one real architectural
  change in the whole scope. It reuses the existing upgrade (bearer token, Origin allowlist), the
  existing reconnect with backoff, and the existing per user rate limits.
- **In memory only**, like rooms. A map from user id to their open sockets, and from user id to
  the set of friends who should hear about them. A server restart drops it, and everyone shows
  Offline until their client reconnects a few seconds later.
- **Fan out.** On a state change, the server sends `presence.update { contactId, state }` to the
  online friends of that person, computed per recipient (contactId is per viewer). On connect, a
  client gets `presence.snapshot` with the current state of each friend.
- **Visibility is applied at the source.** Someone appearing offline is simply never fanned out
  as Online. The client is never sent a "hidden" state to filter.
- **Logging.** Counts and durations only: number of sockets, number of fan outs. Never names, and
  never who is friends with whom.

## 4. Calling a friend directly

### 4.1 The flow

1. Caller taps a friend. The pre join screen opens as today, with the dialect pair already
   filled in (section 7, idea 1).
2. Caller sends `call.ring { contactId }`. The server checks the friendship, the block table and
   the caps, creates a room exactly as `room.create` does, and puts the caller in it.
3. Every online socket of the callee gets `call.incoming { ringId, from: { contactId,
   displayName } }`. The web shows an incoming call banner with a ringtone; iOS shows a full
   screen incoming call view while in the foreground.
4. Callee taps **Answer**: `call.answer { ringId }` joins them to the room, exactly as `room.join`
   would. Other devices of the callee stop ringing.
5. Callee taps **Decline**, or 30 seconds pass: the caller sees "No answer" (the same words for
   both, see 3.2) and the room is closed.
6. Caller can **Cancel** while it rings.

The room code never appears on either screen. A ring is a room created for two named people, so
nobody else can join it with a code.

### 4.2 Busy

If the callee is already in a call, the ring still arrives as a quiet banner ("Leo is calling")
with Decline and "Answer and end current call". The caller is NOT told "busy" if the callee
appears offline, only "No answer", so busy cannot reveal a hidden person.

### 4.3 Money

A ring costs nothing: no translation happens until both are in the room. Once answered it is an
ordinary call under the same ledger and the same caps (global, per room, and per user once it
exists). Nothing in this scope touches `server/src/spend/` or `pricing.ts`.

### 4.4 Missed calls

An unanswered ring writes a call history row for both sides with a new `outcome` column
(`answered`, `missed`, `declined`, `cancelled`). Declined is recorded as `missed` on the caller's
side, again so a decline is never revealed. Recent calls shows "Missed call from Ana" with a Call
back button. With no push in the MVP, a missed call is how someone learns a ring happened while
they were away.

### 4.5 With push later (M30)

When CallKit and push arrive, the same `call.ring` also sends a VoIP push to the callee's
devices, and an iOS ring works with the app closed. The wire messages above do not change. At
that point "Offline" stops meaning "unreachable", which is one more reason appear offline was
defined as "still rings" from the start.

## 5. What changes, by area

| Area | Change | Paths |
| --- | --- | --- |
| Store | Migrations (append only): `friendships` (ordered pair, nickname per side, created_at), `friend_requests` (from, to, created_at, expires, declined_at), `friend_links` (user, token hash, created_at), `presence_visible` on preferences, `outcome` on `call_history` | `server/src/store/migrations.ts` |
| Account | Friends service: request, accept, decline, cancel, unfriend, nickname, link reset and redeem; block hooks; contactId resolution widened | `server/src/account/`, new `server/src/friends/` |
| HTTP | Routes in `HTTP_ROUTES`, schemas in a new `shared/src/friends.ts`, `API_VERSION` bump | `shared/src/http.ts`, `server/src/http.ts` |
| Wire | `presence.snapshot`, `presence.update`, `call.ring`, `call.incoming`, `call.answer`, `call.decline`, `call.cancel`, `call.ended_unanswered`; `PROTOCOL_VERSION` bump, fixtures regenerated | `shared/src/protocol.ts`, `shared/wire/` |
| Socket server | Home connection (no room), presence registry with grace, ring lifecycle with timeout | `server/src/ws/server.ts`, new `server/src/presence/` |
| Logger | No new forbidden keys needed beyond names, which are already withheld; a test that a nickname is dropped | `server/src/log.ts` |
| Web | Friends page (requests, list, presence dots, nickname), friend link and QR, add from Recent calls, incoming call banner, visibility toggle, missed calls | `client/src/` |
| Copy | Every new string in all five catalogs, checked at Spanish length | `client/src/i18n/*.json` |
| iOS | The same screens in SwiftUI, after the MVP screens exist | `ios/` |

## 6. Interface notes (Appendix C applies)

- **Presence is a dot plus a word**, never color alone: a filled dot with "Online", a ring with
  "In a call". Spanish runs longer ("En línea", "En una llamada"), so status text sits on its own
  line under the name, not squeezed beside it.
- **The friend row's hierarchy:** name first and heaviest, then status, then the dialect
  ("Español, Argentina"). Call is the single primary action on the row; Block, Report, Nickname and
  Unfriend live behind a menu so a row is not a strip of five buttons.
- **The incoming call banner** names the caller in large type, and Answer and Decline are full
  width, at least 44 points tall, with their labels allowed to wrap in Spanish rather than
  truncate.
- **No layout shift** when a friend comes online: rows re-sort only when the list is not being
  touched, so a row does not jump from under a finger.

## 7. Extra ideas, with a recommendation each

Asked for: special design features that fit this app in particular. In order of value:

1. **Dialect on every friend, used automatically. Recommend for v1.** A friend's card shows
   their dialect ("Español, Argentina"), from their saved preference, and ringing them fills in
   both sides of the pre join screen. This is the feature no other calling app has, it costs
   one field already stored, and it removes the most common mistake (the wrong Spanish).
2. **Their local time, and Do not disturb. Recommend for v1.** Cross border friends are the core
   audience (Buenos Aires, Madrid and Los Angeles are 3 to 9 hours apart). Show "10:40 pm their
   time" on the card, from the device's time zone, shared with friends only and switchable off.
   Pair it with Do not disturb (manual, or quiet hours): rings to you become missed calls and the
   caller sees "No answer". This is the honest version of what people often want "appear
   offline" to do.
3. **"Let me know when they're online." Recommend for v2.** A one shot nudge on a friend: the
   next time they come online (and are visible), you get a notice. In a world without push it
   replaces most of what push would give, and it respects appear offline because it fires only on
   a visible Online.
4. **Friend names are never translated. Recommend for v1 if not already true.** When you call a
   friend, both display names (and your private nickname for them) go into that call's prompt as
   do not translate terms, so "Paz" does not become "Peace". It reuses the glossary path with no
   new storage, and it lives only in the prompts of translations you read, matching the private
   glossary rule.
5. **Friend links that can carry an invite. Recommend later, owner decided.** When signup opens up,
   a friend link could also grant signup, so a user brings their Spanish speaking friend in one
   step. Today this would bypass the invite gate that protects the shared spend cap, so it waits
   for the money model and per user caps.

Deliberately left out: groups or favorites (the list is small and calls are two person), a
public profile or status message (more to moderate under guideline 1.2), contact book import
(uploads other people's numbers), and "last seen" (section 3.1).

## 8. Privacy and safety checklist

- Presence and rings reach accepted friends only, never across a block, never to Recent calls
  contacts.
- Appear offline, decline, busy and block are each indistinguishable from plain silence or
  "No answer" on the other side.
- No search, so nobody can test whether an email has an account.
- No account id ever leaves the server; contactId stays the only handle.
- Presence is in memory only. Nothing about who was online when is stored.
- Nicknames and display names are never logged.
- Account deletion cascades through every friends table.
- Block and Report sit on every friend and request (guideline 1.2).

## 9. Open questions for the owner

1. **When.** Recommended: after the MVP ships to TestFlight (a Phase 5), with the server and web
   parts runnable in cloud sessions at any time since they need no device. Pulling it into the MVP
   adds roughly four C1 milestones and one C2 milestone before TestFlight.
2. **Appear offline still rings** (recommended), or is appear offline also "do not ring me"?
3. **Local time on the friend card**: on by default with a switch (recommended), or off by default?
4. **Friend limits** in 2.3: fine as starting numbers?
