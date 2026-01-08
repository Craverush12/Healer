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

type LocationInfo = {
  id: string;
  name?: string;
};

let cachedLocationId: string | null = null;
let locationInitPromise: Promise<string | null> | null = null;

function getBaseUrl(env: Env): string {
  return env.GHL_API_BASE_URL.replace(/\/$/, "");
}

function getAuthHeaders(env: Env) {
  return {
    Authorization: `Bearer ${env.GHL_API_KEY}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    Version: "2021-07-28"
  };
}

function getRequestLogMeta(params: { url: string; env: Env; locationId?: string | null }) {
  let path = params.url;
  try {
    path = new URL(params.url).pathname;
  } catch {
    // ignore
  }
  const hasBearer = !!params.env.GHL_API_KEY && params.env.GHL_API_KEY.trim().length > 0;
  const hasLocationId = !!params.locationId && params.locationId.trim().length > 0;
  return { path, hasBearer, hasLocationId };
}

function extractLocationId(location: any): string | null {
  const id = location?.id ?? location?._id ?? null;
  return typeof id === "string" && id.trim().length > 0 ? id : null;
}

function extractLocations(payload: any): LocationInfo[] {
  if (!payload) return [];
  if (Array.isArray(payload.locations)) return payload.locations;
  if (Array.isArray(payload?.data?.locations)) return payload.data.locations;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function fetchLocationIdFromApi(env: Env): Promise<string | null> {
  const base = getBaseUrl(env);
  const endpoints = [
    `${base}/me/locations`,
    `${base}/users/me/locations`,
    `${base}/locations`
  ];

  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: getAuthHeaders(env)
      });

      if (!resp.ok) {
        logger.warn({ status: resp.status, ...getRequestLogMeta({ url, env }) }, "GHL location fetch failed");
        continue;
      }

      const json = (await resp.json()) as any;
      const locations = extractLocations(json);
      if (locations.length === 0) continue;
      const locationId = extractLocationId(locations[0]);
      if (locationId) return locationId;
    } catch (err) {
      logger.warn({ err, ...getRequestLogMeta({ url, env }) }, "GHL location fetch error");
    }
  }

  return null;
}

export async function initGhlClient(env: Env) {
  if (!env.GHL_API_KEY) return null;
  if (env.GHL_LOCATION_ID && env.GHL_LOCATION_ID.trim().length > 0) {
    cachedLocationId = env.GHL_LOCATION_ID.trim();
    return cachedLocationId;
  }
  if (locationInitPromise) return locationInitPromise;

  locationInitPromise = (async () => {
    const locationId = await fetchLocationIdFromApi(env);
    if (locationId) {
      cachedLocationId = locationId;
      logger.info({ locationId }, "GHL locationId detected at startup");
    } else {
      logger.warn("GHL locationId not detected; API calls may require GHL_LOCATION_ID.");
    }
    return cachedLocationId;
  })();

  return locationInitPromise;
}

function resolveLocationId(env: Env): string | null {
  if (env.GHL_LOCATION_ID && env.GHL_LOCATION_ID.trim().length > 0) return env.GHL_LOCATION_ID.trim();
  return cachedLocationId;
}

export function getResolvedLocationId(env: Env): string | null {
  return resolveLocationId(env);
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
  if (!env.GHL_API_KEY) {
    logger.debug({ telegramUserId }, "GHL contact search skipped: no API key");
    return null;
  }

  const url = `${getBaseUrl(env)}/contacts/search`;
  const locationId = resolveLocationId(env);
  
  logger.info({ telegramUserId, locationId, baseUrl: getBaseUrl(env) }, "GHL contact search started");

  const buildBody = (query: string) => ({
    query,
    pageLimit: 1,
    ...(locationId ? { locationId } : {})
  });

  try {
    const queries = [`telegram_user_id:${telegramUserId}`, String(telegramUserId)];
    logger.debug({ telegramUserId, queries }, "GHL contact search queries prepared");

    for (const query of queries) {
      logger.debug({ telegramUserId, query, body: buildBody(query) }, "GHL contact search attempting query");
      
      const resp = await fetch(url, {
        method: "POST",
        headers: getAuthHeaders(env),
        body: JSON.stringify(buildBody(query))
      });

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'Unable to read error response');
        logger.warn(
          { status: resp.status, query, errorText, ...getRequestLogMeta({ url, env, locationId }) },
          "GHL contact search failed - HTTP error"
        );
        continue; // Try next query instead of returning null
      }

      const json = (await resp.json()) as any;
      const contacts = extractContacts(json);
      
      logger.debug({
        telegramUserId,
        query, 
        contactCount: contacts.length,
        responseKeys: Object.keys(json || {})
      }, "GHL contact search response processed");
      
      if (contacts.length === 0) {
        logger.info({ telegramUserId, query }, "GHL contact search - no contacts found for query");
        continue;
      }

      const contact = contacts[0];
      const contactId = extractContactId(contact);
      
      if (!contactId) {
        logger.warn({ telegramUserId, query, contact: Object.keys(contact || {}) }, "GHL contact search - invalid contact ID");
        continue;
      }

      logger.info({ telegramUserId, contactId, query }, "GHL contact search successful");
      return { contactId, contact };
    }

    logger.info({ telegramUserId, queries }, "GHL contact search - no contacts found for any query");
    return null;
  } catch (err) {
    logger.error({ err, telegramUserId, ...getRequestLogMeta({ url, env, locationId }) }, "GHL contact search error - exception thrown");
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
  logger.debug({ url }, "GHL subscription fetch started");
  
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: getAuthHeaders(env)
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unable to read error response');
      logger.warn({ 
        status: resp.status, 
        errorText,
        ...getRequestLogMeta({ url, env }) 
      }, "GHL subscription fetch failed - HTTP error");
      return null;
    }

    const json = (await resp.json()) as any;
    const subs = extractSubscriptions(json);
    
    logger.debug({
      url,
      subscriptionCount: subs.length,
      responseKeys: Object.keys(json || {}),
      rawSubscriptions: subs.map(s => ({ 
        id: s?.id, 
        status: s?.status || s?.subscription_status || s?.state,
        active: s?.active || s?.isActive
      }))
    }, "GHL subscription fetch response processed");
    
    if (subs.length === 0) {
      logger.info({ url }, "GHL subscription fetch - no subscriptions found");
      return { isActive: false, cancelAtPeriodEnd: false, ended: false, source: url, count: 0 };
    }

    const normalized = subs.map(normalizeSubscription);
    const anyActive = normalized.some((s) => s.isActive);
    const anyCancelPending = normalized.some((s) => s.isActive && s.cancelAtPeriodEnd);
    const anyEnded = normalized.some((s) => s.ended);

    const result = {
      isActive: anyActive,
      cancelAtPeriodEnd: anyCancelPending,
      ended: anyEnded,
      source: url,
      count: subs.length
    };
    
    logger.info({
      url,
      subscriptionCount: subs.length,
      result,
      normalizedStatuses: normalized.map(n => ({
        status: n.status,
        isActive: n.isActive,
        cancelAtPeriodEnd: n.cancelAtPeriodEnd,
        ended: n.ended
      }))
    }, "GHL subscription fetch successful");

    return result;
  } catch (err) {
    logger.error({ err, ...getRequestLogMeta({ url, env }) }, "GHL subscription fetch error - exception thrown");
    return null;
  }
}

export async function getSubscriptionStatusForContact(params: {
  env: Env;
  contactId: string;
}): Promise<SubscriptionStatus | null> {
  const { env, contactId } = params;
  if (!env.GHL_API_KEY) {
    logger.debug({ contactId }, "GHL subscription lookup skipped: no API key");
    return null;
  }

  const base = getBaseUrl(env);
  const locationId = resolveLocationId(env);
  const locationParam = locationId ? `&locationId=${encodeURIComponent(locationId)}` : "";
  const endpoints = [
    `${base}/subscriptions?contactId=${encodeURIComponent(contactId)}${locationParam}`,
    `${base}/payments/subscriptions?contactId=${encodeURIComponent(contactId)}${locationParam}`
  ];

  logger.info({ contactId, locationId, endpoints }, "GHL subscription lookup started");

  for (const url of endpoints) {
    logger.debug({ contactId, url }, "GHL subscription lookup trying endpoint");
    const result = await fetchSubscriptions(env, url);
    if (result && (result.count > 0 || result.isActive)) {
      logger.info({ contactId, url, result }, "GHL subscription lookup successful - found active data");
      return result;
    } else if (result) {
      logger.debug({ contactId, url, result }, "GHL subscription lookup - endpoint responded but no active subscriptions");
    }
  }

  logger.warn({ contactId, endpoints }, "GHL subscription lookup - no active subscriptions found in any endpoint");
  return null;
}
