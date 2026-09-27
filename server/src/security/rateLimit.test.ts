import { describe, expect, it } from "vitest";
import { LIMITS, TokenBuckets } from "./rateLimit.js";

const T0 = 1_000_000;

describe("TokenBuckets", () => {
  it("allows a burst then refuses", () => {
    const buckets = new TokenBuckets({ ratePerSecond: 1, burst: 3 });
    expect(buckets.take("ip", T0)).toBe(true);
    expect(buckets.take("ip", T0)).toBe(true);
    expect(buckets.take("ip", T0)).toBe(true);
    expect(buckets.take("ip", T0)).toBe(false);
  });

  it("refills over time", () => {
    const buckets = new TokenBuckets({ ratePerSecond: 1, burst: 2 });
    buckets.take("ip", T0);
    buckets.take("ip", T0);
    expect(buckets.take("ip", T0)).toBe(false);
    expect(buckets.take("ip", T0 + 1_000)).toBe(true);
  });

  it("never refills past the burst size", () => {
    const buckets = new TokenBuckets({ ratePerSecond: 1, burst: 2 });
    buckets.take("ip", T0);
    // An hour later the bucket is full, not overflowing.
    expect(buckets.take("ip", T0 + 3_600_000)).toBe(true);
    expect(buckets.take("ip", T0 + 3_600_000)).toBe(true);
    expect(buckets.take("ip", T0 + 3_600_000)).toBe(false);
  });

  it("keeps keys independent", () => {
    const buckets = new TokenBuckets({ ratePerSecond: 1, burst: 1 });
    expect(buckets.take("a", T0)).toBe(true);
    expect(buckets.take("a", T0)).toBe(false);
    expect(buckets.take("b", T0)).toBe(true);
  });

  it("sweeps refilled buckets so the map does not grow forever", () => {
    // A slow memory leak that only shows up in production and looks like something else.
    const buckets = new TokenBuckets({ ratePerSecond: 1, burst: 2 });
    buckets.take("a", T0);
    buckets.take("b", T0);
    expect(buckets.size).toBe(2);

    buckets.sweep(T0 + 10_000);
    expect(buckets.size).toBe(0);
  });

  it("keeps a bucket that is still draining", () => {
    const buckets = new TokenBuckets({ ratePerSecond: 1, burst: 10 });
    buckets.take("a", T0);
    buckets.sweep(T0 + 1_000);
    expect(buckets.size).toBe(1);
  });
});

describe("the configured limits", () => {
  it("makes an 8 character room code unguessable", () => {
    // 32^8 is about 1.1e12. At the join limit, a single attacker gets 10 guesses a minute, so
    // the expected time to one hit against 1,000 live rooms is measured in centuries. That is
    // the entire security model for room access.
    const attemptsPerMinute = LIMITS.joinPerIp.ratePerSecond * 60;
    expect(attemptsPerMinute).toBeLessThanOrEqual(10);

    const keyspace = 32 ** 8;
    const liveRooms = 1_000;
    const minutesToHit = keyspace / liveRooms / attemptsPerMinute;
    const yearsToHit = minutesToHit / (60 * 24 * 365);
    expect(yearsToHit).toBeGreaterThan(100);
  });

  it("leaves normal speech well clear of the translation limit", () => {
    // About 8 turns a minute is ordinary conversation. A limit that a real pair of people could
    // touch would be a bug report, not a guard.
    const perMinute = LIMITS.translationsPerRoom.ratePerSecond * 60;
    expect(perMinute).toBeGreaterThanOrEqual(24);
  });

  it("leaves interim results well clear of the message limit", () => {
    // Interim transcripts arrive at roughly 5 per second while someone is talking.
    expect(LIMITS.messagesPerConnection.ratePerSecond).toBeGreaterThanOrEqual(30);
  });
});
