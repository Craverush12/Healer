import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number };

/**
 * Minimal in-memory fixed-window rate limiter.
 * MVP intent: protect /webhooks from accidental floods. Not intended for multi-instance deployments.
 */
export function createIpRateLimiter(params: { windowMs: number; max: number }) {
  const { windowMs, max } = params;
  const buckets = new Map<string, Bucket>();

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `ip:${ip}`;

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({ ok: false, error: "rate_limited" });
      return;
    }

    return next();
  };
}

