import type { Request, Response } from "express";
import { Router } from "express";
import type { Env } from "../config/env";
import type { SqliteDb } from "../db/db";
import { tryInsertWebhookEvent } from "../db/eventsRepo";
import { applyStateTransition, getUser, upsertUserIfMissing } from "../db/usersRepo";
import { logger } from "../logger";
import { extractIdempotencyKey, sha256Hex } from "./idempotency";
import { deriveNextState, normalizeWebhook } from "./eventHandlers";
import { verifyHmacSha256 } from "./verifySignature";
import { fetchTelegramUserIdByContactId } from "../ghl/contactLookup";
import { consumeCheckoutToken } from "../db/checkoutTokenRepo";

export function createGhlWebhookRouter(params: {
  env: Env;
  db: SqliteDb;
  sendTelegramMessage: (telegramUserId: number, text: string) => Promise<void>;
}) {
  const { env, db, sendTelegramMessage } = params;
  const router = Router();

  function redactCustomData(input: any) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (/secret|token|key|authorization|password/i.test(key)) {
        redacted[key] = "[redacted]";
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  router.post("/ghl", async (req: Request, res: Response) => {
    const receivedAt = Date.now();

    const rawBody =
      Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from(typeof req.body === "string" ? req.body : "");
    if (!rawBody || rawBody.length === 0) {
      res.status(400).json({ ok: false, error: "Expected raw body" });
      return;
    }

    // Auth: prefer signature header if secret configured + header present; otherwise token query.
    // If payments are disabled, webhook auth is optional (for testing)
    const signatureHeader = String(req.header("x-wh-signature") ?? req.header("X-WH-SIGNATURE") ?? "").trim();
    const signatureTimestamp = String(req.header("x-wh-timestamp") ?? req.header("X-WH-TIMESTAMP") ?? "").trim();
    const token = typeof req.query.token === "string" ? req.query.token : "";

    let authed = false;
    if (env.ENABLE_PAYMENTS) {
      // Payments enabled - require authentication
      if (env.GHL_WEBHOOK_SECRET && signatureHeader) {
        const sig = verifyHmacSha256({
          rawBody,
          secret: env.GHL_WEBHOOK_SECRET,
          headerSignature: signatureHeader,
          headerTimestamp: signatureTimestamp || undefined,
          maxSkewMs: 5 * 60 * 1000 // 5 minutes tolerance if timestamp present
        });
        authed = sig.valid;
        if (!sig.valid) {
          logger.warn({ reason: sig.reason }, "Webhook signature verification failed");
        }
      } else if (env.WEBHOOK_TOKEN && token) {
        authed = token === env.WEBHOOK_TOKEN;
      } else if (env.WEBHOOK_TOKEN && !signatureHeader) {
        // Tenant might not support signatures; token-only mode.
        authed = token === env.WEBHOOK_TOKEN;
      }

      if (!authed) {
        logger.warn({ hasSignatureHeader: !!signatureHeader }, "Webhook rejected (auth failed)");
        res.status(401).json({ ok: false });
        return;
      }
    } else {
      // Payments disabled - allow webhooks for testing (optional auth)
      if (env.WEBHOOK_TOKEN && token) {
        authed = token === env.WEBHOOK_TOKEN;
      } else {
        // No auth required when payments disabled (testing mode)
        authed = true;
        logger.info("Webhook accepted without auth (payments disabled - testing mode)");
      }
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ ok: false, error: "Invalid JSON" });
      return;
    }

    const payloadHash = sha256Hex(rawBody);
    const idempotencyKey = extractIdempotencyKey(payload, payloadHash);

    const normalized = normalizeWebhook(payload);
    let telegramUserId = normalized.telegramUserId;

    // Token-based linking: if telegram_user_id is missing, try resolving a checkout token.
    if (!telegramUserId) {
      const tokenFromPayload =
        payload?.token ??
        payload?.checkoutToken ??
        payload?.metadata?.token ??
        payload?.metadata?.checkoutToken ??
        null;
      const tokenFromQuery = typeof req.query.token === "string" ? req.query.token : "";
      const tokenToUse = typeof tokenFromPayload === "string" && tokenFromPayload.trim().length > 0 ? tokenFromPayload : tokenFromQuery;
      if (tokenToUse) {
        const resolved = consumeCheckoutToken(db, tokenToUse.trim());
        if (resolved) {
          telegramUserId = resolved;
          normalized.telegramUserId = resolved;
        }
      }
    }

    const eventInsert = tryInsertWebhookEvent({
      db,
      provider: "GHL",
      idempotencyKey,
      eventType: normalized.eventType,
      receivedAt,
      payloadHash,
      telegramUserId
    });

    if (!eventInsert.inserted) {
      logger.info({ idempotencyKey }, "Webhook duplicate ignored");
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    if (!telegramUserId && normalized.contactId) {
      try {
        telegramUserId = await fetchTelegramUserIdByContactId({ env, contactId: normalized.contactId });
      } catch (err) {
        logger.warn({ err, contactId: normalized.contactId }, "Contact lookup failed");
      }
    }

    if (!telegramUserId) {
      // MVP-safe: do not grant/revoke access if we can't link the contact to a Telegram user.
      logger.warn({ idempotencyKey, contactId: normalized.contactId }, "Webhook stored but unlinked (no telegram_user_id)");
      res.status(200).json({ ok: true, unlinked: true });
      return;
    }

    // Ensure user exists even if webhook arrives before /start.
    upsertUserIfMissing(db, telegramUserId);

    const prev = getUser(db, telegramUserId);
    const { nextState, reason } = deriveNextState(normalized);

    if (!nextState) {
      if (reason === "unknown_event") {
        const payloadSource =
          payload?.customData && typeof payload.customData === "object" && !Array.isArray(payload.customData)
            ? payload.customData
            : payload;
        const customDataKeys = payloadSource && typeof payloadSource === "object" ? Object.keys(payloadSource) : [];
        logger.warn(
          {
            eventType: normalized.eventType,
            customDataKeys,
            customData: redactCustomData(payload?.customData ?? null)
          },
          "Webhook received unknown event_type"
        );
      }
      if ((normalized.eventType ?? "").toLowerCase().includes("payment.failed")) {
        // Notify best-effort.
        try {
          await sendTelegramMessage(
            telegramUserId,
            "Payment failed. Please update your payment method in Manage Subscription to avoid losing access."
          );
        } catch (err) {
          logger.warn({ err, telegramUserId }, "Telegram notify failed (payment.failed)");
        }
      }
      logger.info({ telegramUserId, reason }, "Webhook processed (no state change)");
      res.status(200).json({ ok: true });
      return;
    }

    const applied = applyStateTransition({
      db,
      telegramUserId,
      nextState,
      eventAt: normalized.eventAt,
      ghlContactId: normalized.contactId
    });

    if (!applied) {
      logger.warn({ telegramUserId, eventAt: normalized.eventAt }, "Webhook suppressed (out of order)");
      res.status(200).json({ ok: true, suppressed: true });
      return;
    }

    const didChange = prev?.state !== nextState;
    logger.info({ telegramUserId, from: prev?.state, to: nextState }, "User state updated");

    if (didChange) {
      const msg =
        nextState === "ACTIVE_SUBSCRIBER"
          ? "✅ Subscription active — you now have access to the audio library."
          : nextState === "CANCEL_PENDING"
            ? "⚠️ Cancellation scheduled — you will keep access until the end of your billing cycle."
            : "❌ Subscription ended — access has been revoked.";

      try {
        await sendTelegramMessage(telegramUserId, msg);
      } catch (err) {
        logger.warn({ err, telegramUserId }, "Telegram notify failed (state change)");
      }
    }

    res.status(200).json({ ok: true });
  });

  return router;
}
