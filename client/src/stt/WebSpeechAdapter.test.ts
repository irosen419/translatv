import { afterEach, describe, expect, it, vi } from "vitest";
import { detectCapabilities, PROBE_TIMEOUT_MS, WebSpeechAdapter } from "./WebSpeechAdapter.js";
import type { SttEvents } from "./types.js";

/**
 * Minimal stand in for the browser's SpeechRecognition.
 *
 * processLocally is assigned in the constructor rather than only declared, because the adapter
 * guards on `"processLocally" in recognition` and a field that is never assigned would fail that
 * check for the wrong reason, making the test pass while proving nothing.
 */
class FakeRecognition {
  static instances: FakeRecognition[] = [];

  lang = "";
  continuous = false;
  interimResults = false;
  processLocally: boolean | undefined;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;

  constructor() {
    this.processLocally = undefined;
    FakeRecognition.instances.push(this);
  }

  start(): void {
    this.onstart?.();
  }
  stop(): void {}
  abort(): void {}
}

const noopEvents: SttEvents = {
  onInterim() {},
  onFinal() {},
  onStatus() {},
};

/** One entry of the browser's cumulative results collection. */
function result(transcript: string, isFinal: boolean) {
  return { isFinal, 0: { transcript, confidence: 0.9 } };
}

/**
 * An onresult event shaped like Chrome's.
 *
 * `results` is CUMULATIVE for the life of one recognition object: every event carries every
 * result the session has produced so far, and `resultIndex` points at the first one that changed.
 * That is the whole bug: the loop read from resultIndex to the end of a growing list with no
 * record of what it had already emitted, so a redelivery re-emitted finals that were already on
 * screen, and each one was a PAID translation call for a sentence nobody said twice.
 */
function resultEvent(resultIndex: number, results: ReturnType<typeof result>[]) {
  return { resultIndex, results: Object.assign([...results], { length: results.length }) };
}

/** Install the fake engine, reporting the given on device availability. */
function installEngine(availability: string) {
  FakeRecognition.instances = [];
  const install = vi.fn(async () => true);
  const available = vi.fn(async () => availability);
  Object.assign(FakeRecognition, { available, install });
  Reflect.set(globalThis, "SpeechRecognition", FakeRecognition);
  return { available, install };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "SpeechRecognition");
  vi.useRealTimers();
});

describe("WebSpeechAdapter on device preference", () => {
  it("uses the on device model by default when it is available", async () => {
    installEngine("available");
    const adapter = new WebSpeechAdapter(noopEvents);
    try {
      await adapter.start(null, "en-US");
      expect(FakeRecognition.instances.at(-1)?.processLocally).toBe(true);
    } finally {
      adapter.stop();
    }
  });

  it("leaves processLocally alone when the caller prefers the cloud engine", async () => {
    // The reason this control exists: Chrome's on device model is markedly worse on fast speech,
    // and today it is selected silently whenever it happens to be installable.
    installEngine("available");
    const adapter = new WebSpeechAdapter(noopEvents, false);
    try {
      await adapter.start(null, "en-US");
      expect(FakeRecognition.instances.at(-1)?.processLocally).toBeUndefined();
    } finally {
      adapter.stop();
    }
  });

  it("does not download a model the caller has opted out of", async () => {
    // Downloading a model that will never be used is a real cost on a phone.
    const { install } = installEngine("downloadable");
    const adapter = new WebSpeechAdapter(noopEvents, false);
    try {
      await adapter.start(null, "en-US");
      expect(install).not.toHaveBeenCalled();
    } finally {
      adapter.stop();
    }
  });

  it("reports the engine actually in use through onStatus", async () => {
    installEngine("available");
    const statuses: string[] = [];
    const adapter = new WebSpeechAdapter(
      { ...noopEvents, onStatus: (s) => statuses.push(`${s.kind}:${"onDevice" in s ? s.onDevice : ""}`) },
      false,
    );
    try {
      await adapter.start(null, "en-US");
      // The chip in the header reads this, so it has to say cloud when cloud is what is running.
      expect(statuses).toContain("listening:false");
    } finally {
      adapter.stop();
    }
  });
});

// Every duplicate final here is a paid translation call for a sentence already on screen, which
// is why this is tested by counting onFinal rather than by inspecting any internal bookkeeping.
// The client's own dedupe cannot catch these: it is keyed on the server minted lineId, and a
// resend arrives as a brand new line with a brand new id.
describe("WebSpeechAdapter duplicate finals", () => {
  it("fires a redelivered final exactly once", async () => {
    installEngine("available");
    const finals: string[] = [];
    const adapter = new WebSpeechAdapter({ ...noopEvents, onFinal: (t) => finals.push(t) }, false);
    try {
      await adapter.start(null, "en-US");
      const recognition = FakeRecognition.instances.at(-1)!;

      recognition.onresult?.(resultEvent(0, [result("do you have time tomorrow", true)]));
      // The same cumulative collection delivered again, which is what Chrome does under
      // continuous = true.
      recognition.onresult?.(resultEvent(0, [result("do you have time tomorrow", true)]));

      expect(finals).toEqual(["do you have time tomorrow"]);
    } finally {
      adapter.stop();
    }
  });

  it("fires each final once when a later event replays the whole collection", async () => {
    installEngine("available");
    const finals: string[] = [];
    const adapter = new WebSpeechAdapter({ ...noopEvents, onFinal: (t) => finals.push(t) }, false);
    try {
      await adapter.start(null, "en-US");
      const recognition = FakeRecognition.instances.at(-1)!;

      recognition.onresult?.(resultEvent(0, [result("first sentence", true)]));
      recognition.onresult?.(
        resultEvent(0, [result("first sentence", true), result("second sentence", true)]),
      );

      expect(finals).toEqual(["first sentence", "second sentence"]);
    } finally {
      adapter.stop();
    }
  });

  it("still fires a result that was interim first and final later", async () => {
    // A result at a given index legitimately arrives interim and is finalized in a later event.
    // Suppressing by index alone, rather than by index that has already FIRED, would swallow it.
    installEngine("available");
    const finals: string[] = [];
    const interims: string[] = [];
    const adapter = new WebSpeechAdapter(
      { ...noopEvents, onFinal: (t) => finals.push(t), onInterim: (t) => interims.push(t) },
      false,
    );
    try {
      await adapter.start(null, "en-US");
      const recognition = FakeRecognition.instances.at(-1)!;

      recognition.onresult?.(resultEvent(0, [result("do you have", false)]));
      recognition.onresult?.(resultEvent(0, [result("do you have time", true)]));

      expect(interims).toEqual(["do you have"]);
      expect(finals).toEqual(["do you have time"]);
    } finally {
      adapter.stop();
    }
  });

  it("still fires real finals after a restart, which resets the browser's indices", async () => {
    // The trap in the obvious fix. A restart builds a NEW recognition object whose results start
    // at index 0 again, so a high water mark carried across the restart would swallow every final
    // of the next session: the engine restarts about once a minute on the cloud path, so that
    // would be a worse bug than the one being fixed.
    vi.useFakeTimers();
    installEngine("available");
    const finals: string[] = [];
    const adapter = new WebSpeechAdapter({ ...noopEvents, onFinal: (t) => finals.push(t) }, false);
    try {
      await adapter.start(null, "en-US");
      const first = FakeRecognition.instances.at(-1)!;
      first.onresult?.(resultEvent(0, [result("before the restart", true)]));

      // The session ends on its own (the silence timeout) and the supervisor respawns.
      first.onend?.();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(FakeRecognition.instances.length).toBe(2);

      const second = FakeRecognition.instances.at(-1)!;
      expect(second).not.toBe(first);
      second.onresult?.(resultEvent(0, [result("after the restart", true)]));

      expect(finals).toEqual(["before the restart", "after the restart"]);
    } finally {
      adapter.stop();
      vi.useRealTimers();
    }
  });

  it("fires an identical sentence said twice in one session, because that is a real second one", async () => {
    // Deduping on TEXT rather than on index would silently eat a repeated "yes" or "hello",
    // which people say constantly. The index is the identity here, not the words.
    installEngine("available");
    const finals: string[] = [];
    const adapter = new WebSpeechAdapter({ ...noopEvents, onFinal: (t) => finals.push(t) }, false);
    try {
      await adapter.start(null, "en-US");
      const recognition = FakeRecognition.instances.at(-1)!;

      recognition.onresult?.(resultEvent(0, [result("yes", true)]));
      recognition.onresult?.(resultEvent(1, [result("yes", true), result("yes", true)]));

      expect(finals).toEqual(["yes", "yes"]);
    } finally {
      adapter.stop();
    }
  });
});

/**
 * A stalled availability probe.
 *
 * Reported from an iPhone running Safari: the pre join screen showed NO speech recognition
 * notice at all, which none of the three branches can produce, and in the call the other side's
 * speech was never transcribed while typed messages arrived normally. Both symptoms are the same
 * cause. `SpeechRecognition.available()` exists and its promise never settles, and it was awaited
 * in two places with nothing bounding the wait: the try/catch around it stops a REJECTION, and a
 * promise that simply never resolves is not a rejection.
 */
function installStalledEngine() {
  FakeRecognition.instances = [];
  Object.assign(FakeRecognition, {
    available: vi.fn(() => new Promise(() => {})),
    install: vi.fn(async () => true),
  });
  Reflect.set(globalThis, "SpeechRecognition", FakeRecognition);
}

describe("an availability probe that never settles", () => {
  it("does not stop detectCapabilities from answering", async () => {
    // The pre join screen renders nothing at all until this resolves, so hanging here means the
    // person is told neither that subtitles work nor that they do not.
    installStalledEngine();
    vi.useFakeTimers();

    const pending = detectCapabilities("en-US");
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    const caps = await pending;

    // The engine is present, so this is not the unsupported case. We simply could not confirm
    // the on device model, and the cloud path is what the adapter will fall back to anyway.
    expect(caps.supported).toBe(true);
    expect(caps.onDeviceAvailable).toBe(false);
  });

  it("does not stop recognition from starting", async () => {
    // The one that actually cost a call. start() awaits prepareOnDevice and then spawns, so a
    // probe that never settles means spawn() is never reached: no recognition object is ever
    // created, no error is raised, and `running` still reports true because started was set
    // before the await. Silent and total.
    installStalledEngine();
    vi.useFakeTimers();

    const adapter = new WebSpeechAdapter(noopEvents);
    const started = adapter.start(null, "en-US");
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    await started;

    expect(FakeRecognition.instances).toHaveLength(1);
    expect(FakeRecognition.instances[0]?.lang).toBe("en-US");
  });

  it("falls back to the cloud path rather than claiming on device", async () => {
    // Worse than no subtitles would be subtitles that claim the audio stayed on the machine
    // when we never got an answer either way.
    installStalledEngine();
    vi.useFakeTimers();

    const adapter = new WebSpeechAdapter(noopEvents);
    const started = adapter.start(null, "en-US");
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    await started;

    expect(FakeRecognition.instances[0]?.processLocally).toBeUndefined();
  });

  it("does not carry a previous yes into a later start that got no answer", async () => {
    // onDevice lives on the adapter, not on one recognition session, and prepareOnDevice runs
    // again on every start(). Stopping and starting again is a real path: the manual restart
    // control after a failure does exactly this. Without a null check the stale true survives
    // the second probe, and the UI goes on saying the audio never left the machine on the word
    // of an answer that arrived before the engine stopped answering.
    installEngine("available");
    vi.useFakeTimers();

    const adapter = new WebSpeechAdapter(noopEvents);
    const first = adapter.start(null, "en-US");
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(FakeRecognition.instances[0]?.processLocally).toBe(true);

    adapter.stop();
    Object.assign(FakeRecognition, { available: vi.fn(() => new Promise(() => {})) });

    const second = adapter.start(null, "en-US");
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    await second;

    expect(FakeRecognition.instances).toHaveLength(2);
    expect(FakeRecognition.instances[1]?.processLocally).toBeUndefined();
  });
});

/**
 * A working engine that is simply slow.
 *
 * These pin the timeout's VALUE, which the stalled probe tests above do not. Those advance by
 * PROBE_TIMEOUT_MS + 1, which is self referential: review set the constant to 0 and all of them
 * still passed, because a zero length race still resolves and a fast engine's microtask still
 * beats a macrotask. They prove a race exists, never that it waits long enough to be useful.
 *
 * So these use absolute milliseconds on purpose. They fail if the budget is cut below about four
 * seconds, which is the point: dropping a real answer from a slow engine is a silent privacy
 * downgrade, and it should cost a red test rather than nobody noticing.
 */
function installSlowEngine(answerAfterMs: number, availability = "available") {
  FakeRecognition.instances = [];
  Object.assign(FakeRecognition, {
    available: vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(availability), answerAfterMs)),
    ),
    install: vi.fn(async () => true),
  });
  Reflect.set(globalThis, "SpeechRecognition", FakeRecognition);
}

describe("an engine that answers slowly but does answer", () => {
  it("honors an on device answer that takes 3.5 seconds", async () => {
    installSlowEngine(3_500);
    vi.useFakeTimers();

    const caps = detectCapabilities("en-US");
    await vi.advanceTimersByTimeAsync(4_000);

    expect((await caps).onDeviceAvailable).toBe(true);
  });

  it("uses the on device path in the call too, not just the notice", async () => {
    // The pre join notice and what start() actually does have to agree. A budget that honors a
    // slow answer on one screen and gives up on the other would say the audio stayed on the
    // machine and then send it to the vendor.
    installSlowEngine(3_500);
    vi.useFakeTimers();

    const adapter = new WebSpeechAdapter(noopEvents);
    const started = adapter.start(null, "en-US");
    await vi.advanceTimersByTimeAsync(4_000);
    await started;

    expect(FakeRecognition.instances[0]?.processLocally).toBe(true);
  });

  it("still gives up on an answer that takes 10 seconds", async () => {
    // Generous is not unbounded. The point of the budget is that a call starts.
    installSlowEngine(10_000);
    vi.useFakeTimers();

    const adapter = new WebSpeechAdapter(noopEvents);
    const started = adapter.start(null, "en-US");
    await vi.advanceTimersByTimeAsync(6_000);
    await started;

    expect(FakeRecognition.instances).toHaveLength(1);
    expect(FakeRecognition.instances[0]?.processLocally).toBeUndefined();
  });
});
