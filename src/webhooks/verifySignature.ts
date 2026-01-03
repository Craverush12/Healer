import crypto from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Minimal MVP signature verification.
 *
 * Note: Different GHL tenants may encode signatures differently (hex vs base64).
 * This implementation assumes `x-wh-signature` contains a lowercase hex digest of:
 *   HMAC_SHA256(secret, rawBody)
 */
export function verifyHmacSha256Hex(params: {
  rawBody: Buffer;
  secret: string;
  headerSignature: string;
}): boolean {
  const { rawBody, secret, headerSignature } = params;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const actual = headerSignature.trim();
  return safeEqual(expected, actual);
}

