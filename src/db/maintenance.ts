import { deleteExpiredCheckoutTokens } from "./checkoutTokenRepo";
import type { SqliteDb } from "./db";
import { deleteWebhookEventsOlderThan } from "./eventsRepo";

export type DbMaintenanceResult = {
  nowMs: number;
  webhookEventsCutoffMs: number;
  deletedExpiredCheckoutTokens: number;
  deletedOldWebhookEvents: number;
};

export function runDbMaintenance(params: {
  db: SqliteDb;
  webhookEventsRetentionDays: number;
  nowMs?: number;
}): DbMaintenanceResult {
  const { db, webhookEventsRetentionDays } = params;
  const nowMs = params.nowMs ?? Date.now();
  const retentionDays = Math.max(1, Math.floor(webhookEventsRetentionDays));
  const webhookEventsCutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;

  let deletedExpiredCheckoutTokens = 0;
  let deletedOldWebhookEvents = 0;

  const txn = db.transaction(() => {
    deletedExpiredCheckoutTokens = deleteExpiredCheckoutTokens(db, nowMs);
    deletedOldWebhookEvents = deleteWebhookEventsOlderThan(db, webhookEventsCutoffMs);
  });
  txn();

  return {
    nowMs,
    webhookEventsCutoffMs,
    deletedExpiredCheckoutTokens,
    deletedOldWebhookEvents
  };
}

