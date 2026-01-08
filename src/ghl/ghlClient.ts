import type { Env } from "../config/env";
import { logger } from "../logger";

type ContactRecord = {
  id?: string;
  _id?: string;
};

type SubscriptionFlags = {
  isActive: boolean;
  cancelAtPeriodEnd: boolean;
  ended: boolean;
  status: string | null;
};

type SubscriptionStatus = {
  isActive: boolean;
  cancelAtPeriodEnd: boolean;
  ended: boolean;
  source: string;
  count: number;
};

function getBaseUrl(env: Env): string {
  return env.GHL_API_BASE_URL.replace(/\/$/, "");
}

function getAuthHeaders(env: Env) {
  return {
    Authorization: `Bearer ${env.GHL_API_KEY}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}

function extractContactId(contact: any): string | null {
  const id = contact?.id ?? contact?._id ?? null;
  return typeof id === "string" && id.trim().length > 0 ? id : null;
}

function extractContacts(payload: any): any[] {
  if (!payload) return [];
  if (Array.isArray(payload.contacts)) return payload.contacts;
  if (Array.isArray(payload?.data?.contacts)) return payload.data.contacts;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export async function findContactByTelegramUserId(params: {
  env: Env;
  telegramUserId: number;
}): Promise<{ contactId: string; contact: any } | null> {
  const { env, telegramUserId } = params;
  if (!env.GHL_API_KEY) return null;

  const url = `${getBaseUrl(env)}/contacts/search`;
  const body = {
    query: String(telegramUserId),
    pageLimit: 1
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders(env),
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status }, "GHL contact search failed");
      return null;
    }

    const json = (await resp.json()) as any;
    const contacts = extractContacts(json);
    if (contacts.length === 0) return null;

    const contact = contacts[0];
    const contactId = extractContactId(contact);
    if (!contactId) return null;

    return { contactId, contact };
  } catch (err) {
    logger.warn({ err }, "GHL contact search error");
    return null;
  }
}

function normalizeSubscription(sub: any): SubscriptionFlags {
  const rawStatus = sub?.status ?? sub?.subscription_status ?? sub?.state ?? null;
  const status = typeof rawStatus === "string" ? rawStatus.toLowerCase() : null;

  const isActive =
    sub?.active === true ||
    sub?.isActive === true ||
    (status ? ["active", "trialing"].includes(status) : false);

  const cancelAtPeriodEnd =
    sub?.cancelAtPeriodEnd === true ||
    sub?.cancel_at_period_end === true ||
    sub?.cancelAtPeriod === true ||
    sub?.cancel_at_period === true;

  const ended =
    sub?.ended === true ||
    sub?.canceled === true ||
    sub?.cancelled === true ||
    (status ? ["canceled", "cancelled", "ended", "expired"].includes(status) : false);

  return { isActive, cancelAtPeriodEnd, ended, status };
}

function extractSubscriptions(payload: any): any[] {
  if (!payload) return [];
  if (Array.isArray(payload.subscriptions)) return payload.subscriptions;
  if (Array.isArray(payload?.data?.subscriptions)) return payload.data.subscriptions;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

async function fetchSubscriptions(env: Env, url: string): Promise<SubscriptionStatus | null> {
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: getAuthHeaders(env)
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, url }, "GHL subscription fetch failed");
      return null;
    }

    const json = (await resp.json()) as any;
    const subs = extractSubscriptions(json);
    if (subs.length === 0) return { isActive: false, cancelAtPeriodEnd: false, ended: false, source: url, count: 0 };

    const normalized = subs.map(normalizeSubscription);
    const anyActive = normalized.some((s) => s.isActive);
    const anyCancelPending = normalized.some((s) => s.isActive && s.cancelAtPeriodEnd);
    const anyEnded = normalized.some((s) => s.ended);

    return {
      isActive: anyActive,
      cancelAtPeriodEnd: anyCancelPending,
      ended: anyEnded,
      source: url,
      count: subs.length
    };
  } catch (err) {
    logger.warn({ err, url }, "GHL subscription fetch error");
    return null;
  }
}

export async function getSubscriptionStatusForContact(params: {
  env: Env;
  contactId: string;
}): Promise<SubscriptionStatus | null> {
  const { env, contactId } = params;
  if (!env.GHL_API_KEY) return null;

  const base = getBaseUrl(env);
  const endpoints = [
    `${base}/subscriptions?contactId=${encodeURIComponent(contactId)}`,
    `${base}/payments/subscriptions?contactId=${encodeURIComponent(contactId)}`
  ];

  for (const url of endpoints) {
    const result = await fetchSubscriptions(env, url);
    if (result) return result;
  }

  return null;
}
