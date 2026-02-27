import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number; lastSeenAt: number };

function pruneExpiredBuckets(buckets: Map<string, Bucket>, now: number) {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function evictOldestBuckets(buckets: Map<string, Bucket>, keepSize: number) {
  if (buckets.size <= keepSize) return;
  const entries = [...buckets.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
  const removeCount = Math.max(0, buckets.size - keepSize);
  for (let i = 0; i < removeCount; i += 1) {
    buckets.delete(entries[i][0]);
  }
}

/**
 * Minimal in-memory fixed-window rate limiter.
 * MVP intent: protect /webhooks from accidental floods. Not intended for multi-instance deployments; use a shared store (e.g., Redis) if running more than one instance.
 */
export function createIpRateLimiter(params: {
  windowMs: number;
  max: number;
  maxBuckets?: number;
  cleanupIntervalMs?: number;
}) {
  const { windowMs, max, maxBuckets = 10_000, cleanupIntervalMs = 60_000 } = params;
  const buckets = new Map<string, Bucket>();
  let lastCleanupAt = 0;

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    if (now - lastCleanupAt >= cleanupIntervalMs) {
      pruneExpiredBuckets(buckets, now);
      lastCleanupAt = now;
    }

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `ip:${ip}`;

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= maxBuckets) {
        pruneExpiredBuckets(buckets, now);
        if (buckets.size >= maxBuckets) {
          // Keep some headroom after eviction to avoid churning on every request.
          evictOldestBuckets(buckets, Math.max(1, Math.floor(maxBuckets * 0.9)));
        }
      }
      buckets.set(key, { count: 1, resetAt: now + windowMs, lastSeenAt: now });
      return next();
    }

    bucket.count += 1;
    bucket.lastSeenAt = now;
    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({ ok: false, error: "rate_limited" });
      return;
    }

    return next();
  };
}

