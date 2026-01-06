import crypto from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseTimestampMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Numeric epoch seconds or ms.
  const num = Number(trimmed);
  if (Number.isFinite(num)) {
    // Heuristic: treat >= 1e12 as ms, otherwise seconds.
    return num >= 1_000_000_000_000 ? num : num * 1000;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Verify HMAC-SHA256 with flexible encoding (hex or base64) and optional timestamp tolerance.
 *
 * Many GHL tenants send `x-wh-signature` as either lowercase hex or base64 of:
 *    HMAC_SHA256(secret, rawBody)
 * If `headerTimestamp` is provided (e.g., `x-wh-timestamp`), we enforce a max age window when `maxSkewMs` is set.
 */
export function verifyHmacSha256(params: {
  rawBody: Buffer;
  secret: string;
  headerSignature: string;
  headerTimestamp?: string | null;
  maxSkewMs?: number;
}): { valid: boolean; reason?: string } {
  const { rawBody, secret, headerSignature, headerTimestamp, maxSkewMs } = params;
  const actual = headerSignature.trim();
  if (!actual) return { valid: false, reason: "missing_signature" };

  if (maxSkewMs && maxSkewMs > 0) {
    const tsMs = parseTimestampMs(headerTimestamp);
    if (tsMs !== null) {
      const now = Date.now();
      const skew = Math.abs(now - tsMs);
      if (skew > maxSkewMs) {
        return { valid: false, reason: "timestamp_skew" };
      }
    }
  }

  const hmac = crypto.createHmac("sha256", secret).update(rawBody);
  const expectedHex = hmac.digest("hex");
  const expectedBase64 = Buffer.from(expectedHex, "hex").toString("base64");

  if (safeEqual(expectedHex, actual)) return { valid: true };
  if (safeEqual(expectedBase64, actual)) return { valid: true };

  return { valid: false, reason: "signature_mismatch" };
}

