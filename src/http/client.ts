import { logger } from "../logger";

type RetryableMethod = "GET" | "HEAD" | "OPTIONS" | "POST";

const DEFAULT_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export type HttpFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  signal?: AbortSignal | null;
  redirect?: "follow" | "error" | "manual";
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitterMs?: number;
  retryOnStatuses?: Set<number> | number[];
  requestName?: string;
  logMeta?: Record<string, unknown>;
  idempotent?: boolean;
};

function safeUrlMeta(url: string): { host: string | null; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname };
  } catch {
    return { host: null, path: url };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number, base: number, max: number, jitter: number): number {
  const exp = Math.min(max, base * Math.max(1, 2 ** (attempt - 1)));
  const extra = jitter > 0 ? Math.floor(Math.random() * jitter) : 0;
  return exp + extra;
}

function normalizeRetryStatuses(input?: Set<number> | number[]): Set<number> {
  if (!input) return DEFAULT_RETRYABLE_STATUSES;
  if (input instanceof Set) return input;
  return new Set(input);
}

function isRetryableMethod(method: string, idempotent: boolean): boolean {
  if (idempotent) return true;
  const upper = method.toUpperCase() as RetryableMethod;
  return upper === "GET" || upper === "HEAD" || upper === "OPTIONS";
}

function createAttemptSignal(timeoutMs: number, upstream?: AbortSignal | null) {
  const controller = new AbortController();
  let timedOut = false;

  const onUpstreamAbort = () => {
    controller.abort(upstream?.reason);
  };

  if (upstream) {
    if (upstream.aborted) {
      controller.abort(upstream.reason);
    } else {
      upstream.addEventListener("abort", onUpstreamAbort, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timeoutId.unref?.();

  return {
    signal: controller.signal,
    wasTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeoutId);
      if (upstream) upstream.removeEventListener("abort", onUpstreamAbort);
    }
  };
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as any).name === "AbortError";
}

function isRetryableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as any;
  if (isAbortError(anyErr)) return true;
  if (typeof anyErr.message === "string" && anyErr.message.toLowerCase().includes("fetch failed")) return true;
  if (typeof anyErr.code === "string") {
    return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(anyErr.code);
  }
  return false;
}

export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<any> {
  const {
    timeoutMs = 10_000,
    maxRetries = 2,
    retryBaseDelayMs = 250,
    retryMaxDelayMs = 2_000,
    retryJitterMs = 150,
    retryOnStatuses,
    requestName = "http_request",
    logMeta,
    idempotent = false,
    signal: upstreamSignal,
    method: methodInput,
    headers,
    body,
    redirect
  } = options;

  const method = String(methodInput ?? "GET").toUpperCase();
  const canRetry = maxRetries > 0 && isRetryableMethod(method, idempotent);
  const retryStatuses = normalizeRetryStatuses(retryOnStatuses);
  const maxAttempts = canRetry ? maxRetries + 1 : 1;
  const urlMeta = safeUrlMeta(url);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptSignal = createAttemptSignal(timeoutMs, upstreamSignal);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        redirect,
        signal: attemptSignal.signal
      });
      attemptSignal.cleanup();

      const shouldRetryStatus =
        canRetry && attempt < maxAttempts && retryStatuses.has(response.status);

      if (!shouldRetryStatus) {
        return response;
      }

      try {
        await response.body?.cancel();
      } catch {
        // Ignore body cancellation issues on retry.
      }

      const waitMs = backoffDelayMs(attempt, retryBaseDelayMs, retryMaxDelayMs, retryJitterMs);
      logger.warn(
        {
          requestName,
          method,
          status: response.status,
          attempt,
          maxAttempts,
          waitMs,
          ...urlMeta,
          ...logMeta
        },
        "HTTP request retrying after retryable status"
      );
      await delay(waitMs);
      continue;
    } catch (err: unknown) {
      const timedOut = attemptSignal.wasTimeout();
      attemptSignal.cleanup();

      const upstreamAborted = !!upstreamSignal?.aborted;
      const shouldRetryError =
        canRetry && attempt < maxAttempts && !upstreamAborted && (timedOut || isRetryableNetworkError(err));

      if (!shouldRetryError) {
        throw err;
      }

      const waitMs = backoffDelayMs(attempt, retryBaseDelayMs, retryMaxDelayMs, retryJitterMs);
      logger.warn(
        {
          requestName,
          method,
          timedOut,
          attempt,
          maxAttempts,
          waitMs,
          errorName: (err as any)?.name,
          errorCode: (err as any)?.code,
          errorMessage: (err as any)?.message,
          ...urlMeta,
          ...logMeta
        },
        "HTTP request retrying after network/timeout error"
      );
      await delay(waitMs);
    }
  }

  throw new Error("httpFetch exhausted retries unexpectedly");
}
