export interface VelocityLimitAllowed {
  allowed: true;
}

export interface VelocityLimitRejected {
  allowed: false;
  retryAfterMs: number;
}

export type VelocityLimitResult = VelocityLimitAllowed | VelocityLimitRejected;

/**
 * Explicit type guard rather than relying on inline `.allowed` narrowing —
 * this pattern has caused a Vercel-only build failure multiple times this
 * project even when local tsc is clean on the same TypeScript version.
 */
export function isVelocityLimitRejected(
  result: VelocityLimitResult,
): result is VelocityLimitRejected {
  return result.allowed === false;
}

export interface PurchaseVelocityLimiterOptions {
  /** Max checkout-session attempts allowed within the sliding window. */
  maxAttempts: number;
  windowMs: number;
}

/**
 * Purchase velocity limit (Epic 6.10, #107): a sliding-window counter per
 * user — distinct from refinement-rate-limiter.ts's fixed cooldown, since
 * "too many checkout attempts in a short span" (a scripted card-testing
 * pattern) is better modeled as "at most N attempts per window" than "not
 * too soon after the last one." A rejected attempt is never itself counted
 * — it must not extend how long the user stays rate-limited.
 */
export function createPurchaseVelocityLimiter(options: PurchaseVelocityLimiterOptions) {
  const { maxAttempts, windowMs } = options;
  const attemptsByUser = new Map<string, number[]>();

  function check(userId: string): VelocityLimitResult {
    const now = Date.now();
    const attempts = (attemptsByUser.get(userId) ?? []).filter((t) => now - t < windowMs);

    if (attempts.length >= maxAttempts) {
      const oldest = attempts[0]!;
      attemptsByUser.set(userId, attempts);
      return { allowed: false, retryAfterMs: windowMs - (now - oldest) };
    }

    attempts.push(now);
    attemptsByUser.set(userId, attempts);
    return { allowed: true };
  }

  return { check };
}
