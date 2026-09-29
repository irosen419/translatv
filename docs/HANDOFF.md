# Translatv: brainstorm handoff

A snapshot taken 2026-09-28, evening UTC. It holds everything needed to brainstorm Translatv's
money model and next steps. It is written so that a fresh Claude, for example in Claude Voice,
can pick the project up cold. Nothing in it is secret: this repository is public.

## Read this first (for the assistant)

You are helping the owner of Translatv make decisions, by voice. How to use this file:

- **Treat the facts here as the project's state on 2026-09-28.** Prices were read that day.
  - A figure marked as an estimate rests on the assumptions stated beside it.
  - Do not invent prices, benchmarks or quality claims. If a number is not in this file, say
    that it is not known.
- **The goal of a session is decisions on the open questions in section 9.**
  - Take one question at a time.
  - Give the trade off in a sentence or two, recommend an answer when the facts support one, then ask.
  - Keep spoken replies short.
- **Build on the owner's direction.** It is in section 4, quoted where the owner wrote it.
  Build on it rather than reopening it, unless a fact here argues otherwise; then name the fact.
- **Close by reading back** the decisions made and the questions still open, so they can be
  written into the repository afterwards.
- **Money, keys and publishing are the owner's calls.** Anything that spends, such as the paid
  model test, needs the owner's explicit go ahead. Every paid call is logged in the spend ledger
  before the next one is sent.

A suggested order for a first session:

1. Who pays for a call's translation (section 9, question 1).
2. The price shape and the free tier, with the money math (section 5).
3. Ads, in or out.
4. The translation model, and whether to run the paid blind test (section 6).
5. Launch platforms.
6. Whatever is left in section 9.

## 1. The one minute version

- **What it is.** Translatv is a two person video call app with live translated subtitles
  between English and Spanish. That includes regional Spanish: Argentine voseo, Colombian
  usted, Mexican, and Peninsular.
- **Where it is.** The web app works today, and an iOS app is planned next.
- **What translation costs.** It runs on Claude Haiku 4.5, at about $0.68 per hour of
  conversation.
- **What is decided.** Each user pays for their own translation, with no default spending cap
  and an optional one they set themselves.
- **What is open.** How customers pay. The owner's starting idea was a $5 app, plus ads, plus an
  ad free premium tier. The math says that works on a much cheaper model, not on Haiku, unless a
  subscription or an allowance carries the heavy users.

## 2. The product

- **A call.** Two people share one room, joined with an 8 character room code.
  - Video and audio go peer to peer over WebRTC, so the server never sees or hears them.
  - Each device turns only its own speech into text, using free on-device speech recognition,
    and sends that text to the server.
  - The server translates the text and sends it to the other person.
  - Subtitles show the translation large, with the original small beneath it. There is text
    chat too.
- **Languages.** Six dialects:
  - English, as spoken in the United States and the United Kingdom.
  - Spanish, as spoken in Argentina, Mexico, Spain and Colombia.

  The Spanish varieties differ most in how they say "you": vos in Argentina, usted in
  Colombia, tú in Mexico, and tú with plural vosotros in Spain. The app's own screens are
  written in each variety too.
- **Translation.**
  - The server calls Claude Haiku 4.5 (`claude-haiku-4-5`).
  - The prompt names both dialects, and carries examples, recent conversation context, a
    glossary and corrections.
  - A translation times out after 6 seconds, at most 8 run at once, and a reply is capped at 512
    tokens.
- **Glossary and corrections.**
  - A glossary is a list of terms the translator must use, such as names.
  - A correction is a fix one person makes to a translation during a call. Today it lasts only
    for the rest of that call.
- **Accounts** (added 2026-09-28):
  - Email and password. Signup is invite only by default, and the owner mints the invites.
  - Each account can store preferences, a glossary, call history and contacts (people it has
    called).
  - Deleting an account erases it from the database files themselves, not only from the tables.
  - Transcripts are never stored on the server.
- **Spend tracking.**
  - Every paid API call is written to an append only ledger (`out/translatv/spend_log.jsonl`)
    before the next one is sent.
  - Two caps guard spend today: a global daily cap ($10 by default) and a per room cap ($1.50
    by default).
  - With no ledger, translation refuses rather than guessing.
- **Not verified yet.**
  - Nobody has checked translation quality with a real API key in this repository. The costs
    below come from real calls in the project Translatv was copied from.
  - Echo and speech recognition have not been tested on real phones.

## 3. Where the work stands (2026-09-28)

| Item | State |
| --- | --- |
| [#1](https://github.com/irosen419/translatv/pull/1): accounts, SQLite storage, per user data, and the protocol export the iOS app builds on | **Merged into main on 2026-09-28**, after ten rounds of adversarial review |
| [#2](https://github.com/irosen419/translatv/pull/2): per user spend charged to the room's host, with a $1 default daily cap | **Paused by the owner** for the money model. It gets reshaped after the brainstorm |
| [#3](https://github.com/irosen419/translatv/pull/3): log what a timed out translation cost, and never bill a user for it | **Built, and in review.** An adversarial review loop is running, up to five rounds. It is held for the owner because it touches spend |
| The iOS app | **Not started.** Planned as a native SwiftUI app for iOS 26. The first version runs only in the foreground, with no CallKit and no push |
| Deploying with accounts | **Not done.** It needs `AUTH_SECRET`, `OWNER_EMAIL`, `SIGNUP_MODE` and a volume for the database |

The plan of record is [`docs/PLAN.md`](PLAN.md).

## 4. Decisions already made

In the owner's words where there are some.

**Money**

- **Each user pays for their own translation** (2026-09-28). The owner's words:

  > We'll need others to pay for their translation, which means we don't set any default cap
  > and they should be able to set their cap manually if they want one.

  This replaces #2's design, in which the host pays under a $1 default daily cap.
- **Timed out requests are logged, and the business eats their cost** (2026-09-28). The owner's words:

  > I think it should be logged but as far as billing goes, I think we need to eat the cost
  > instead of charging the customer.

  Anthropic bills a request the client gives up on, so these are real costs. #3 builds this.
- **In-app and device notifications, and a billing page, are needed** (2026-09-28). The owner's words:

  > we probably need in-app and device notifications and a full billing page with their
  > allowance/tokens/bank or whatever we decide to call it.

  What the allowance is called, and what it counts, is still open.
- **The starting idea for pricing, not yet decided** (2026-09-28). The owner's words:

  > I'm thinking if we charge $5 for the app and then institute ads and another paid ads free
  > premium version, we can get a lump sum that will, on average, outweigh their usage. But I
  > don't want to make that assumption without some serious calculations.

  Section 5 is those calculations.
- **Look for better models, not only cheaper ones** (2026-09-28). The research covers models
  that may translate better than Haiku, and better speech recognition. It is in section 6.
- **When to plan the business.** The owner first planned "discussing this after the app is
  actually built". It came forward because #2's design depended on it.

**Product**

- **Nobody downloads transcripts anymore** (2026-09-28): "no one should be able to download the
  transcript from the chatroom anymore". Removing the download is a queued follow up.
- **Corrections are saved to the account** (2026-09-28):
  - The owner's words: "corrections should be saved overall", with "a way to filter out
    malicious corrections for sure".
  - The owner asked whether that screening should be "a nightly job? Or a post-call job".
  - Recommended, not yet confirmed: screen after each call, and save to an account only the
    corrections its own owner made (section 8).
- **Deleted accounts are fully erased from the database files** (2026-09-28, done in #1).
- **#1 is merged** (2026-09-28, at the owner's go ahead).
- **The iOS contract comes next** (2026-09-28). It is a new branch and pull request after #1. It
  exports schemas and fixtures for the account API, so the iOS app can be built against them.
- **No brainstorm reminder** (2026-09-28). The owner is brainstorming from this file instead.

**From the plan of record (2026-09-27)**

- **Platforms.** iOS first, and Android later. The app must serve many users.
- **One project, one public repository.** Translatv is its own project, with its own server,
  in one public repository. It is public because GitHub's macOS runners are free for public
  repositories.
- **The iOS stack.** Native SwiftUI with a minimum of iOS 26, WebRTC through LiveKit's WebRTC
  build, and Apple's `SpeechTranscriber` for speech recognition.
- **Signup is invite only by default.** Every account spends against one shared daily cap, so
  open signup would let a stranger spend the owner's money down to it. Open signup is a single
  setting.
- **Joining a call needs an account.** Letting a guest join by link without one waits until
  there is an answer for who pays for that guest's translation.

## 5. The money math

**The headline.**

- **What Haiku costs.** Translating with Claude Haiku 4.5 costs about **$0.68 per hour of
  conversation**. That is an estimate, between $0.34 and $1.01.
- **What a sale buys.** A $4.99 sale nets $4.24 after Apple's 15%. That pays for about **6
  call-hours per customer, once**.
- **What smaller models change.** They cut the cost 4x to 17x, but nobody has measured their
  quality on voseo or regional Spanish.

**What the numbers rest on.**

- **Real calls.** $0.000563 per translation, measured over 136 real calls on Haiku 4.5 in the
  original project's ledger.
- **Haiku's price.** $1 per million input tokens and $5 per million output tokens. It caches
  nothing under 4,096 tokens.
- **One unmeasured number.** How many finished sentences the speech recognizer hands over per
  minute of conversation. The tables assume 20, and the real figure is likely 10 to 30. Every
  language model's cost scales with it.
- **Other billing models.** Paid speech to text, and all in one speech translation, bill for
  every minute both microphones stream instead.

| Translation option | Call-hours a $4.99 sale pays for | Per month at 2 h of calls | At 8 h | At 30 h |
| --- | --- | --- | --- | --- |
| Claude Haiku 4.5 (today) | 6 | $1.35 | $5.40 | $20.27 |
| Claude Sonnet 5 | 2 | $3.51 | $14.05 | $52.70 |
| Gemini 3.1 Flash-Lite | 24 | $0.36 | $1.42 | $5.34 |
| GPT-6 Luna | 63 | $0.14 | $0.54 | $2.03 |
| GPT-5 nano | 108 | $0.08 | $0.31 | $1.18 |
| On-device (Apple Translation on iOS, Chrome on desktop) | unlimited | $0 | $0 | $0 |

These are whole-call costs at 20 sentences a minute. When both people on a call are paying
customers, each carries about half. When the other person is not a paying customer, the
customer carries all of it.

What this means for $4.99, plus ads, plus a premium tier:

- **On Haiku it does not add up.**
  - A regular user (8 hours a month) costs $5.40 a month, more than the whole purchase nets.
  - One US interstitial ad per 20 minute call covers about 6% of that call's translation.
  - Ad rates in Latin America run roughly 3x to 10x lower.
- **On a small model it can.**
  - On GPT-6 Luna, the purchase covers about 63 call-hours.
  - One US interstitial per call covers about 64% of its translation.
  - Heavy users still outrun any one time price. A premium tier (for example $4.99 a month,
    $4.24 net) or a monthly allowance has to carry them.
- **Free on-device translation is the floor.** Apple's Translation framework and Chrome's
  Translator API cost nothing per call, but give no control over dialect. They could carry a
  free tier, or take over when someone's allowance runs out.
- **Paid speech to text roughly doubles the bill.**
  - It adds $0.30 to $2.04 per call-hour.
  - Keep the free on-device recognizers unless testing shows their accuracy fails.
  - All in one speech translation, at $4 to $5 per call-hour, is out of reach at these prices.
- **Haiku 4.5 may retire soon.**
  - Anthropic lists its retirement as "not sooner than October 15, 2026", with 60 days' notice,
    and there is no newer Haiku.
  - Anthropic's next option, Sonnet 5, costs 2.6x as much, so a model decision is coming either
    way.
- **Free competition exists.** FaceTime's Live Translation on iOS 26 translates calls at no
  charge. It covers Spanish from Spain but not Mexico, and needs an iPhone 15 Pro or later.
  Pixel 10 and Samsung phones translate calls free too.

Two things would firm this up:
- Counting translations per call on real calls. The spend ledger plus call history can give it.
- A paid blind test of cheaper and better models against Haiku (section 6). It spends money,
  so it needs the owner's go ahead.

## 6. Better translation than Haiku

**Nobody has measured any current model translating into regional Spanish, Haiku included.**
So "better" has to be tested here. The independent evidence that exists leans one way:

- **The contest.** WMT is the yearly machine translation contest, scored by human raters.
- **How Claude did.** It scored below the GPT model of the same generation in 2024 (English to
  Spanish) and in 2025 (other languages).
- **Where the gap was widest.** On transcribed speech, which is what this app translates.
- **The 2026 leaders.** **GPT-5.5 and Gemini 3.1 Pro.** No Claude model entered.

| Model and setting | Evidence it translates better than Haiku | Per call-hour | Wait per subtitle |
| --- | --- | --- | --- |
| Claude Haiku 4.5 (today) | None: never evaluated | $0.68 | 1.0 s |
| **GPT-6 Sol**, reasoning off | One industry benchmark (RWS) | $1.35 | about 1.3 s |
| Claude Sonnet 5, thinking off | None | $1.76 | 1.6 s |
| GPT-5.5, reasoning off | Only measured with reasoning on (next row) | $3.56 | not measured |
| **GPT-5.5**, reasoning on | Shares the top of WMT26 | $7.88 | 2.1 s |
| Gemini 3.1 Pro (always thinks) | Shares the top of WMT26 | $28.22 | 32 to 37 s |
| Claude Opus 5.5, low effort | None | about $6.39 | 6.3 s |
| GPT-6 Astra, low effort | None | about $13.96 | 3.0 s |
| Claude Fable 5.1, low effort | None | about $15.98 | 7.1 s |
| Google Translation LLM | Google's WMT26 entry (engine unnamed): 11.9 points below GPT-5.5 | $2.88 | not published |
| DeepL | Vendor claims only | $3.60 plus a plan fee | not published |

How to read the table:

- **The rate.** Per call-hour means at 20 translations a minute, as in section 5. At 10 or 30 a
  minute, halve it or add half.
- **Reasoning costs money.** A model that reasons is billed for its reasoning. GPT-5.5 used
  about 120 reasoning tokens a sentence in WMT26. The Opus, Astra and Fable figures assume the
  same, so they are estimates.
- **The waits are a ranking only.** They are Artificial Analysis measurements on 10,000 token
  prompts, far longer than this app's.
- **Other WMT26 engines.** Cohere's and Unbabel's translation engines entered too, scoring
  about 9 to 13 and 32 points below the leaders.

What the evidence suggests:

- **Test GPT-6 Sol with reasoning off first.**
  - Its sibling GPT-5.5 shares the top of WMT26, and RWS scores Sol well without reasoning.
  - It answers nearly as fast as Haiku.
  - It costs $0.34 to $1.01 more per call-hour.
- **Sonnet 5 with thinking off is the easiest switch.**
  - It uses the same API and the same spend ledger, at $0.54 to $1.62 more per call-hour.
  - Nothing shows it beats Haiku, though.
  - The server sends `temperature 0.2`, which Sonnet 5 refuses, so that setting has to go first.
- **GPT-5.5 is the ceiling to test against.**
  - It has the best evidence of any model, but only with reasoning on: 11.7x Haiku's cost, and
    about 2 seconds a subtitle.
  - With reasoning off it costs 5.3x Haiku, and nobody has measured its quality that way.
- **Too slow or too dear for live subtitles:**
  - Opus 5.5 and Fable 5.1, at 6 to 7 seconds on low effort;
  - GPT-6 Astra, at 3 seconds and 20x Haiku's cost;
  - Gemini 3.1 Pro, at over 30 seconds on its default thinking level. Its lowest level is
    untested on translation.
- **Is better worth paying for?**
  - Between strong models on a widely spoken pair, the gaps are small: 1.5 points out of 100
    between the two WMT26 leaders.
  - In WMT24, about 3 points separated GPT-4 and Claude 3.5 on English to Spanish, though 6.5 on
    transcribed speech.
  - Switch only if the test below shows about 5 points, or clearly fewer dialect mistakes.
- **DeepL can now take instructions.** It accepts custom instructions for Spanish and its
  variants. The note in `server/src/translate/prompt.ts` saying DeepL cannot be told to use
  voseo is out of date. Whether it follows those instructions is untested.
- **There is time.** Anthropic still lists Haiku 4.5 as active, and gives at least 60 days'
  notice before retiring a model, so Haiku runs until late November at the earliest.

### The test that would settle it

A blind side by side comparison, run the way WMT26 rated its entries, and only when the owner
arms it.

- **What gets translated.** 625 sentences:
  - 125 each into Argentine (voseo), Colombian (usted), Mexican and Peninsular (vosotros)
    Spanish;
  - 125 from Spanish into English.

  They come from consented role play calls through the same speech recognizer, because the app
  never keeps real transcripts. At least 40 per variety speak to the listener directly, which
  is where the dialects differ.
- **Who competes.**
  - Haiku 4.5, Sonnet 5 (thinking off), GPT-6 Sol (reasoning off) and GPT-5.5 (reasoning on).
  - All run with the production prompt, examples, conversation context and glossary.
  - Each one's wait and reasoning tokens are recorded.
  - The cheap models from section 5 (GPT-6 Luna, Gemini 3.1 Flash-Lite) can join for about 13
    cents more.
- **Who judges.** Native speakers of each variety, blind to which model wrote what.
  - Each rates every output from 0 to 100, marks its errors, and answers yes or no to "right
    dialect?".
  - One item in five is rated twice, to check that raters agree.
- **How much it can tell.** 125 sentences per variety detect a 5 point difference. All 500 into
  Spanish together detect about 2.5.
- **Cost.** About $6 in API calls, each logged in the spend ledger before the next is sent. The
  raters' time is the real cost.

**How sure this is.**

- **The WMT scores.** They are averages computed from the raw rating files, because the
  official papers were blocked from the research machine. They agree with the official 2025
  ranking as reported.
- **Unconfirmed details.** The model names in those files (whether "Claude-4" is Sonnet 4, for
  one), and WMT26's reasoning settings.
- **Second hand figures.** OpenAI's prices, its reasoning options, and every wait figure.
- **The leaderboards disagree.**
  - RWS (a panel of AI judges) puts GPT-5.5 first.
  - Alconost's linguists put Gemini first and Claude second, without naming model versions.
- **The Spanish variety studies** test whether models recognize the varieties, not whether
  they translate into them.

## 7. Notifications, the billing page, and App Store rules

Both notifications and the billing page wait on the money model: what a notice says, and what
the billing page shows, depend on who pays and what they buy. Today nothing tells anyone. A
refused translation shows "sin traducir" (untranslated) on a phone, with the reason only in a
tooltip.

| Decision for the brainstorm | Options on the table | Depends on |
| --- | --- | --- |
| What people buy | A one time $4.99 app, a monthly premium tier, an allowance of translated minutes, or a mix | The money math |
| What the allowance is called | Minutes, credits, tokens, or a "bank" | Whether it counts time or money |
| Whose allowance a call uses | The speaker's, the reader's, or whoever started the call | Guests who have no account |
| What the free tier gets | On-device translation only, a small monthly allowance, or nothing | How well on-device translation handles Spanish dialects |
| When people hear about their allowance | In the call, after it, and as a phone notification, at set points such as 80% and 100% | Notification permission on iOS; web push for the browser |
| What happens at zero | Switch to on-device translation, show the original words only, or offer a top up | The free tier |

App Store rules that shape the answers:

- **In-App Purchase is required in the app.** Minutes, credits and subscriptions sold in the
  app must go through Apple's In-App Purchase (guideline 3.1.1).
  - Apple keeps 15% under the Small Business Program, and 30% past $1M a year.
  - It keeps 15% on a subscription after its first paid year.
- **A paid app may also sell a subscription** (guideline 3.1.2). But a new subscription must not
  take away what earlier buyers already paid for.
- **Outside the app, it varies.**
  - On the US storefront an app may link to a web checkout. The commission on those sales is in
    court, at 0% until a rate is set.
  - In the EU, from 2026-10-01, In-App Purchase costs 26%, or 15% for small businesses.
- **Phone notifications need Apple's push service.** That means a signing key kept on the
  server, a secret like the Anthropic key.

## 8. Corrections

**The plan.** Corrections will save to the account automatically, and transcript downloads go
away. The rule that makes auto-save safe: **an account keeps only the corrections its owner
made**, and a short job screens them after each call.

**Today.** A correction lasts for the rest of its call. Carrying it to the next call means
downloading the transcript, then loading it with "Load corrections from a past chat". Accounts
can already store a list of corrections (#1 added that), but the web app never saves to it.

| How a correction could do harm | What stops it |
| --- | --- |
| The other person plants one during your call, auto-save carries it into your account, and it shapes every call you make after | Save to an account only the corrections its owner made |
| It is written as instructions to the translation model rather than as a term | The prompt already fences corrections off as data; the after-call screen is a second check |
| It flips meaning, such as "sí" saved as "no", or an insult in place of a name | The screen flags these, and each person can see and delete their saved corrections |
| A full list (40 entries of up to 600 characters) makes every translation about 12x dearer, roughly $7 more per call-hour on Haiku | Keep the current size limits; under "each pays their own", the list's owner pays |

**After each call, not nightly.**

- **Why after each call.** A job that runs when the call ends has the corrections screened and
  saved before the next call. A nightly job leaves them missing until the next day.
- **What screening costs.** A screen made only of rules costs nothing. A screen that asks a model
  costs about one small request per call, and goes through the spend ledger like any other paid
  call.

## 9. Open questions for the brainstorm

**The money model**

1. **Whose translation is it?** Does a call's translation cost fall on the speaker, the reader,
   or whoever started the call? A person with no account is the hard case.
2. **Free tier.** On-device translation only (free to run, with no dialect control), a small
   monthly allowance, or no free tier?
3. **Price shape.** $4.99 up front plus a premium subscription, or a free app with an allowance
   and a subscription?
4. **Ads, in or out?** They cover about 6% of a call's translation on Haiku, and about two
   thirds in the US on a small model.
5. **The allowance's name.** Minutes, credits, tokens, or a "bank"? The name follows from whether
   it counts time or money.
6. **At zero.** Switch to on-device translation, show the original words only, or offer a top up?
7. **Warnings.** When do people hear about their allowance: in the call, after it, by phone
   notification, at 80% and 100%?
8. **The optional cap each user sets.** Where does it live in the app, and what does a call do
   when it is reached?
9. **Heavy users.** 30 hours a month costs about $20 on Haiku and about $2 on GPT-6 Luna. What
   carries them: a subscription, top ups, or a cheaper model?

**Models and quality**

10. **The paid model test.** May it run? It is about $6 in API calls, each logged first.
    Native-speaker raters for four Spanish varieties are the real cost: who should they be?
11. **A second provider.** OpenAI's models are the strongest candidates for better translation.
    Is another server key and another bill fine, or Anthropic only?
12. **The deadline.** Haiku 4.5 retires no sooner than October 15, 2026, with 60 days' notice,
    and there is no newer Haiku. What is the fallback if the test has not run by then?

**Product and platform**

13. **Launch platforms.** iOS first, or the web too? Chrome's free translator runs on desktop
    only.
14. **Corrections screening.** After each call (recommended) or nightly? Rules only (free), or a
    model check (about one small request per call)?
15. **People without accounts.** May they join by link? That needs an answer to question 1 first.
16. **Open signup.** When? Signup is invite only today, because every account spends against one
    shared daily cap.

**Design calls left open by #1's review.** These are known limits, not bugs.

17. **Signing out leaves a call's connection open.** An open WebSocket outlives sign out.
    Closing it needs the sign in's refresh family id on the access token.
18. **Room codes in call history can be reversed.** They are stored as an unkeyed, truncated
    hash, reversible in minutes on a GPU. A keyed hash touches the spend path, because the
    ledger stores the same value.
19. **A guest's glossary replaces the host's without consent.** A guest's stored glossary
    replaces the host's in the room, with no consent step, and today the host pays for every
    prompt it goes into. Under "each pays their own", who pays for a glossary?
20. **The web keeps its refresh token in localStorage.** An httpOnly cookie is the stronger
    option.
21. **The account API has no version.** It changed without one, and the iOS contract follow up
    should add one.

## 10. The cost calculator (not built yet)

**What it would be.** An interactive page (a Claude artifact, private to the owner unless
shared) that runs the money math in section 5 on the owner's own assumptions. Pricing ideas
could then be tried live during the brainstorm, instead of worked out again by hand.

**Inputs:**
- Hours of calls per month per customer, or a mix of light, regular and heavy users.
- Finished sentences per minute of conversation, the unmeasured number (10 to 30).
- The translation model, from the tables above, or on-device.
- How often the other person on a call is also a paying customer, which splits the cost.
- The price shape: a one time price, a subscription price, an allowance size, a top up price.
- The store's cut: 15%, 30%, or the EU's 26%.
- Ads: ads per call, and ad revenue per thousand views by region.
- Optional paid speech recognition.

**Outputs:**
- Cost per call-hour and per customer per month.
- How many call-hours a sale, or a month's subscription, covers.
- Ad revenue per call, and margin per customer for each tier.
- The break even point: the monthly hours past which a customer costs more than they pay.
- A chart of margin against monthly usage for each model.

**Cost and effort.** It spends nothing, because it is arithmetic on the published prices in
this file, and it is about an hour of work. It has not been built; the owner can ask for it.

## 11. Follow up work

- [x] Merge #1 (done 2026-09-28).
- [ ] **#3, the timeout fix.** Its review loop is running, and it stays held for the owner
      because it touches spend.
  - A timed out request finishes in the background and logs its real cost.
  - A reply that never arrives is logged as "cost unknown", and counted against the caps at its
    worst case.
  - Either way, the row is marked not billed.
- [ ] **The iOS contract.** `schema.json` gains dialect codes and length limits. The account API
      gains exported schemas, fixtures and a version.
- [ ] **Corrections.** Save them to the account and screen them after each call. Remove
      transcript downloads and "Load corrections from a past chat".
- [ ] **Pick a translation model before Haiku 4.5 can retire** (not before October 15, 2026). The
      blind test in section 6 decides it, and needs the owner's go ahead.
- [ ] **Measure finished sentences per call-minute on real calls.** It narrows every cost range
      above about threefold.
- [ ] **Reshape #2 after the brainstorm.**
  - Keep its attribution of spend to an account, its ledger reader fixes, and its Python crash
    fix.
  - Replace the host-pays design and the $1 default cap with the decided model.
- [ ] **Deploy the server with accounts**, and mint the first invites.
- [ ] **Build the iOS app** in two stages:
  - Stage 2 of the plan (milestones M7 to M19) runs in a cloud session.
  - Then comes device work on the owner's Mac and phone (M20 to M28): signing, permissions,
    echo, dialect recognition, TURN for cellular calls, battery, and real translation quality.

## 12. Known limits worth weighing

- **Translation quality into regional Spanish has never been measured**, for any model, Haiku
  included.
- **Tabs share one sign in on the web.**
  - Signing in as another account in one tab moves the other tabs at their next refresh.
  - Nothing can then act as the wrong account: requests, account deletion and calls are all
    guarded. But the switch happens without a word.
- **Erasing a deleted account rewrites the database file.** That takes 8 ms at 1.2 MB, and about
  0.7 seconds at 100 MB. At that size it belongs in a quiet hours job.
- **Concurrent calls can overshoot a spending cap slightly.** At most 8 calls are in flight, which
  is about half a cent at Haiku's prices.
- **A server restart ends every call.** The server keeps rooms in memory, by design.
- **Nobody learns why translation stopped.** When translation is refused, a phone shows only
  "sin traducir", so a person whose allowance ran out would not know it.

## 13. Rules any plan has to respect

- **Spend is recorded before it happens.**
  - Every paid call is written to the ledger before the next one is sent.
  - With no ledger, translation refuses.
  - An unknown cost is recorded as unknown, never as zero, and totals report the known amount as
    a floor.
- **Anything that spends is held for the owner.** Any change that spends money, or touches the
  ledger or the pricing code, waits for the owner whatever a review says.
- **Nothing secret goes in the repository.** Keys live in environment settings, because the
  repository is public.
- **The logs stay clean.** The logger never records transcript text, chat text, usernames or
  glossary content.
- **Media stays peer to peer.** The server never sees audio or video, and each device
  transcribes only its own microphone.
- **Digital goods sold in the app go through In-App Purchase** (section 7).

## 14. Glossary

- **Call-hour:** one hour of a two person call.
- **Host, guest:** the host created the room, and the guest joined it. Both need accounts today.
  A guest without an account is a deferred idea.
- **Room code:** the 8 character code shared to join a call.
- **Voseo, usted, vosotros:** the Spanish forms of "you" that differ by region: vos in
  Argentina, usted as the polite form (and the app's form in Colombia), vosotros for plural
  "you" in Spain.
- **Ledger:** the append only file of every paid call and its cost.
- **Cap:** a spending limit. Today there is a global daily cap and a per room cap. #2 proposed a
  per user cap, and the decided direction makes it optional and set by the user.
- **On-device translation:** Apple's Translation framework on iOS, and Chrome's Translator API
  on desktop. Free per call, with no dialect control.
- **Sentences per minute:** how many finished sentences speech recognition hands the translator
  per minute of conversation. It is the unmeasured number behind every cost range.
- **WMT:** the yearly machine translation contest, scored by human raters.
- **Reasoning, or thinking:** tokens a model spends before answering. They are billed as output,
  and they make replies slower.
- **In-App Purchase:** Apple's payment system, required for digital goods sold in an iOS app.

## 15. Sources

All read on 2026-09-28. Many vendor sites were blocked from the machine that did the research.
Figures from those are marked "second hand": each comes from the search engine's copy of that
exact page, cross-checked against a second source where one existed.

Measured in this repository:

- **The cost per translation:** $0.000563 over 136 real calls on Haiku 4.5, from the original
  project's ledger, cited in `script/verify_translation.mjs`.
- **Prompt sizes:** from the app's own prompt builder, `server/src/translate/prompt.ts`.

Read directly:

- [Anthropic model pricing](https://platform.claude.com/docs/en/about-claude/pricing): Haiku 4.5 $1 / $5 per million tokens, Sonnet 5 $2 / $10
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): Haiku 4.5 caches nothing under 4,096 tokens
- [Anthropic model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations): Haiku 4.5 retires not sooner than October 15, 2026
- [Claude Sonnet 5 overview](https://platform.claude.com/docs/en/models/sonnet-5/overview): new tokenizer, thinking on by default
- [How Claude API usage is billed](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage): failed requests are not charged; a request the client disconnects from or times out on "is still charged"
- [Apple Small Business Program](https://developer.apple.com/app-store/small-business-program/) and [Apple subscriptions](https://developer.apple.com/app-store/subscriptions/): 15% and 30%
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/): 3.1.1 and 3.1.2
- [Apple apps in the EU](https://developer.apple.com/support/apps-in-the-eu): the terms from October 1, 2026
- [Meet the Translation API, WWDC24](https://developer.apple.com/videos/play/wwdc2024/10117/): on-device translation on iOS, iPadOS and macOS
- [Azure speech translation docs](https://github.com/MicrosoftDocs/azure-ai-docs/blob/main/articles/ai-services/speech-service/speech-translation.md): $2.50 per audio hour
- [Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/thinking): Sonnet 5's thinking can be turned off, Opus 5.5 and Fable 5.1 always think, and Sonnet 5 refuses a custom temperature
- [Anthropic thinking cost](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost): reasoning is billed as output
- [Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview): Haiku 4.5 still active
- The [Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5) and [Opus 5.5](https://www.anthropic.com/news/claude-opus-5-5) launch posts and the [Gemini 3.1 Pro model card](https://storage.googleapis.com/deepmind-media/Model-Cards/Gemini-3-1-Pro-Model-Card.pdf): no translation claims
- WMT human rating data for [2024](https://github.com/wmt-conference/wmt24-news-systems), [2025](https://github.com/wmt-conference/wmt25-general-mt) and [2026](https://github.com/wmt-conference/wmt26-general-mt)
- [Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing): Gemini 3.1 Pro $2 / $12 per million tokens
- [Cloud Translation pricing](https://cloud.google.com/products/translate/pricing): Translation LLM $10 per million characters, and [Cloud Translation](https://cloud.google.com/translate) for Google's claim about adaptive translation
- [DeepL's Python library](https://github.com/DeepLcom/deepl-python): custom instructions, formality and context

Second hand:

- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and [GPT-5 nano](https://developers.openai.com/api/docs/models/gpt-5-nano) model pages
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Google Cloud Translation pricing](https://cloud.google.com/translate/pricing), [Azure Translator pricing](https://azure.microsoft.com/en-us/pricing/details/translator/), [DeepL API plans](https://support.deepl.com/hc/en-us/articles/360021200939-DeepL-API-plans)
- [Deepgram pricing](https://deepgram.com/pricing), [AssemblyAI streaming pricing](https://www.assemblyai.com/docs/faq/how-does-universal-streaming-session-based-pricing-work), [OpenAI realtime translate](https://developers.openai.com/api/docs/models/gpt-realtime-translate)
- [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api): on-device, desktop Chrome 138 and later
- [Apple Live Translation](https://support.apple.com/guide/iphone/use-live-captions-and-live-translation-iphb41156356/ios): FaceTime languages
- [Appodeal eCPM report 2025](https://appodeal.com/wp-content/uploads/2025/03/Appodeal-The-Latest-eCPM-Report-2025.pdf), an ad network's own figures, and [Udonis on Latin American ad rates](https://www.blog.udonis.co/mobile-marketing/mobile-apps/ecpms)
- Artificial Analysis latency pages, for example [Haiku 4.5](https://artificialanalysis.ai/models/claude-4-5-haiku/providers), and [its method](https://artificialanalysis.ai/methodology/performance-benchmarking)
- OpenAI prices and reasoning options: [GPT-6 Sol](https://openai.com/index/introducing-gpt-6-sol-and-luna/) (and [VentureBeat](https://venturebeat.com/technology/openai-releases-gpt-6-sol-and-luna-models-slashing-api-costs-50-or-more)), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [GPT-5.5 on OpenRouter](https://openrouter.ai/openai/gpt-5.5)
- [Slator on WMT25](https://slator.com/wmt25-preliminary-results-gemini-2-5-pro-gpt-4-1-lead-ai-translation/) and [on RWS's benchmark](https://slator.com/rws-launches-ai-model-benchmark/), [RWS on GPT-6 Sol](https://www.rws.com/blog/gpt-6-sol-luna-and-claude-opus-5-5-prove-theyre-worth-their-weight-for-multilingual-workflows-on-m-gate/), [Alconost's scoreboard](https://alconost.com/en/blog/best-llm-for-translation-2026)
- Spanish varieties: [arXiv 2504.20049](https://arxiv.org/abs/2504.20049) and [arXiv 2602.09346](https://arxiv.org/html/2602.09346)
- [DeepL's next-gen model](https://www.deepl.com/en/blog/next-gen-language-model), [DeepL pricing](https://www.eesel.ai/blog/deepl-pricing), [Google Translation LLM](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/translate/translate-text), [Cohere North Small Translate](https://cohere.com/blog/north-small-translate), [Gemini 3.1 Pro thinking levels](https://help.apiyi.com/en/gemini-3-1-pro-preview-thinking-level-control-guide-en.html)

## Where else to look

- **The follow-up doc** ("Translatv follow-ups", private to the owner): <https://claude.ai/artifact/AEthq1aBrm8BFcy1KCszHN>.
  This file carries all of it, as of 2026-09-28.
- **In this repository:**
  - [`docs/PLAN.md`](PLAN.md): the plan of record for the server and the iOS app.
  - `README.md`: what runs today, and how to run it.
  - `DEPLOY.md`: deploying with accounts.
  - `CLAUDE.md`: the rules every change follows.
