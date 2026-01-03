import crypto from "node:crypto";

export function sha256Hex(rawBody: Buffer): string {
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}

export function extractIdempotencyKey(payload: any, payloadHash: string): string {
  const webhookId = payload?.webhookId ?? payload?.webhook_id ?? payload?.id;
  if (typeof webhookId === "string" && webhookId.trim().length > 0) return webhookId.trim();
  if (typeof webhookId === "number" && Number.isFinite(webhookId)) return String(webhookId);
  return payloadHash;
}

