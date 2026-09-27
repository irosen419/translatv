// Token bucket rate limiting.
//
// The limits that matter here are not the usual "stop someone hammering an endpoint" ones.
// Two are load bearing:
//
//   join attempts   the ONLY attack on room access. An 8 character code is 40 bits, which is
//                   unguessable at 10 attempts per minute and quite guessable at 10,000.
//   translation     a paid API behind an open room. This is the bill runaway risk, and it is
//                   more likely to be hit by a bug (a restart loop re-sending finals) than by
//                   an attacker.

export interface BucketConfig {
  /** Tokens restored per second. */
  ratePerSecond: number;
  /** Maximum tokens held, which is the burst size. */
  burst: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: BucketConfig) {}

  /**
   * Take one token. Returns false when the bucket is empty.
   *
   * `now` is explicit so this is testable without fake timers, which is the same reason
   * RoomManager takes one.
   */
  take(key: string, now: number, cost = 1): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, { tokens: this.config.burst - cost, updatedAt: now });
      return this.config.burst >= cost;
    }

    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(
      this.config.burst,
      bucket.tokens + elapsedSeconds * this.config.ratePerSecond,
    );
    bucket.updatedAt = now;

    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /** Tokens currently available, for reporting a retry-after to a caller. */
  peek(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.config.burst;
    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    return Math.min(this.config.burst, bucket.tokens + elapsedSeconds * this.config.ratePerSecond);
  }

  /**
   * Drop buckets that have refilled completely.
   *
   * Without this the map grows one entry per IP forever, which is a slow memory leak that only
   * shows up in production and looks like something else.
   */
  sweep(now: number): void {
    const fullAfterSeconds = this.config.burst / this.config.ratePerSecond;
    for (const [key, bucket] of this.buckets) {
      if ((now - bucket.updatedAt) / 1000 > fullAfterSeconds) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * The limits, with the reasoning for each number.
 *
 * These are deliberately generous for a human and tight for a script. A real pair of people on
 * a call will never touch any of them.
 */
export const LIMITS = {
  /** Room creation, per IP. A person makes one room per call, not five per minute. */
  createPerIp: { ratePerSecond: 5 / 60, burst: 5 },
  /** Join attempts, per IP. THE brute force defense on room codes. */
  joinPerIp: { ratePerSecond: 10 / 60, burst: 10 },
  /** Any WebSocket frame, per connection. Generous: interim results arrive at about 5 per second. */
  messagesPerConnection: { ratePerSecond: 60, burst: 120 },
  /** Translations, per room. The bill runaway guard. About 8 turns a minute is normal speech. */
  translationsPerRoom: { ratePerSecond: 30 / 60, burst: 10 },
} as const satisfies Record<string, BucketConfig>;

/**
 * Concurrent WebSocket connections from one address.
 *
 * Not a token bucket: this is a live count, not a rate, because the resource being protected is
 * the open socket itself. The other limits all apply only AFTER a socket is up, and the frame
 * limiter is keyed per connection by design, so a client that reconnects buys itself a fresh
 * burst every time. Without a ceiling on establishment, that is an open door with three locks
 * behind it.
 *
 * Twelve is well clear of legitimate use (a household on one address, several tabs, a reconnect
 * briefly overlapping its predecessor) while keeping the door from being held open indefinitely.
 */
export const MAX_CONNECTIONS_PER_IP = 12;
