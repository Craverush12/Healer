import type { UserState } from "../db/usersRepo";

export type NormalizedWebhook = {
  eventType: string | null;
  eventAt: number | null;
  contactId: string | null;
  telegramUserId: number | null;
  isActive: boolean | null;
  cancelAtPeriodEnd: boolean | null;
  ended: boolean | null;
};

function toBool(v: any): boolean | null {
  if (typeof v === "boolean") return v;
  return null;
}

export function normalizeWebhook(payload: any): NormalizedWebhook {
  const eventTypeRaw = payload?.type ?? payload?.eventType ?? payload?.event_type ?? null;
  const eventType = typeof eventTypeRaw === "string" ? eventTypeRaw : null;

  const ts =
    payload?.timestamp ??
    payload?.createdAt ??
    payload?.created_at ??
    payload?.firedAt ??
    payload?.fired_at ??
    null;
  const eventAt = typeof ts === "number" ? ts : typeof ts === "string" ? Date.parse(ts) : null;
  const safeEventAt = eventAt && Number.isFinite(eventAt) ? eventAt : null;

  const contactIdRaw = payload?.contactId ?? payload?.contact_id ?? payload?.contact?.id ?? null;
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw : typeof contactIdRaw === "number" ? String(contactIdRaw) : null;

  // telegram_user_id can appear in different shapes; we keep this intentionally permissive.
  const tgid =
    payload?.telegram_user_id ??
    payload?.telegramUserId ??
    payload?.contact?.telegram_user_id ??
    payload?.contact?.customFields?.telegram_user_id ??
    payload?.contact?.customFields?.telegramUserId ??
    payload?.contact?.customField?.telegram_user_id ??
    null;
  const telegramUserId =
    typeof tgid === "number" && Number.isFinite(tgid)
      ? tgid
      : typeof tgid === "string" && tgid.trim().length > 0 && Number.isFinite(Number(tgid))
        ? Number(tgid)
        : null;

  // Subscription fields (best-effort; real field names depend on GHL payload).
  const status = payload?.subscription?.status ?? payload?.status ?? null;
  const normalizedStatus = typeof status === "string" ? status.toLowerCase() : null;

  const isActive =
    toBool(payload?.isActive) ??
    toBool(payload?.active) ??
    toBool(payload?.subscription?.active) ??
    (normalizedStatus ? ["active", "trialing"].includes(normalizedStatus) : null);

  const cancelAtPeriodEnd =
    toBool(payload?.cancelAtPeriodEnd) ??
    toBool(payload?.cancel_at_period_end) ??
    toBool(payload?.subscription?.cancelAtPeriodEnd) ??
    toBool(payload?.subscription?.cancel_at_period_end) ??
    null;

  const ended =
    toBool(payload?.ended) ??
    toBool(payload?.subscription?.ended) ??
    (normalizedStatus ? ["canceled", "cancelled", "ended"].includes(normalizedStatus) : null);

  return { eventType, eventAt: safeEventAt, contactId, telegramUserId, isActive, cancelAtPeriodEnd, ended };
}

export function deriveNextState(n: NormalizedWebhook): { nextState: UserState | null; reason: string } {
  const t = n.eventType?.toLowerCase() ?? "";

  if (t.includes("payment.failed")) return { nextState: null, reason: "payment_failed_no_state_change" };

  if (t.includes("subscription.cancelled") || t.includes("subscription.canceled") || n.ended === true) {
    return { nextState: "CANCELLED", reason: "subscription_cancelled_or_ended" };
  }

  if (t.includes("subscription.created")) {
    return { nextState: "ACTIVE_SUBSCRIBER", reason: "subscription_created" };
  }

  if (t.includes("subscription.updated")) {
    if (n.cancelAtPeriodEnd === true) {
      return { nextState: "CANCEL_PENDING", reason: "cancel_at_period_end" };
    }
    if (n.isActive === true && n.cancelAtPeriodEnd === false) {
      return { nextState: "ACTIVE_SUBSCRIBER", reason: "active_not_cancel_pending" };
    }
    // If we cannot classify the update, don't change state.
    return { nextState: null, reason: "subscription_updated_unclassified" };
  }

  // Unknown event types: ignore.
  return { nextState: null, reason: "unknown_event" };
}

