import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPurchaseVelocityLimiter } from './purchase-velocity-limiter.js';

describe('createPurchaseVelocityLimiter (#107)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows checkout attempts up to the configured max within the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = createPurchaseVelocityLimiter({ maxAttempts: 3, windowMs: 60_000 });

    expect(limiter.check('user-1').allowed).toBe(true);
    expect(limiter.check('user-1').allowed).toBe(true);
    expect(limiter.check('user-1').allowed).toBe(true);
  });

  it('rejects the attempt once the max is exceeded within the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = createPurchaseVelocityLimiter({ maxAttempts: 3, windowMs: 60_000 });

    limiter.check('user-1');
    limiter.check('user-1');
    limiter.check('user-1');
    const result = limiter.check('user-1');

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('allows further attempts once the oldest attempt ages out of the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = createPurchaseVelocityLimiter({ maxAttempts: 2, windowMs: 60_000 });

    limiter.check('user-1'); // t=0
    vi.setSystemTime(30_000);
    limiter.check('user-1'); // t=30_000, 2 attempts in window, at the limit
    expect(limiter.check('user-1').allowed).toBe(false); // t=30_000, 3rd attempt rejected

    vi.setSystemTime(60_001); // the t=0 attempt has now aged out
    expect(limiter.check('user-1').allowed).toBe(true);
  });

  it('tracks each user independently', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = createPurchaseVelocityLimiter({ maxAttempts: 1, windowMs: 60_000 });

    limiter.check('user-1');
    const result = limiter.check('user-2');

    expect(result.allowed).toBe(true);
  });

  it('does not count a rejected attempt toward a later window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = createPurchaseVelocityLimiter({ maxAttempts: 1, windowMs: 60_000 });

    limiter.check('user-1'); // allowed, t=0
    limiter.check('user-1'); // rejected, t=0 — must not itself count as a new attempt
    vi.setSystemTime(60_001);
    const result = limiter.check('user-1');

    expect(result.allowed).toBe(true);
  });
});
