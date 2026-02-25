import type { Env } from "../config/env";
import { httpFetch } from "../http/client";

function extractTelegramUserIdFromContact(contact: any): number | null {
  const direct =
    contact?.telegram_user_id ??
    contact?.telegramUserId ??
    contact?.customFields?.telegram_user_id ??
    contact?.customFields?.telegramUserId ??
    null;

  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (typeof direct === "string" && direct.trim().length > 0 && Number.isFinite(Number(direct))) return Number(direct);

  const customFields = contact?.customFields ?? contact?.customField ?? contact?.custom_fields ?? null;
  if (Array.isArray(customFields)) {
    for (const f of customFields) {
      const key = (f?.key ?? f?.name ?? f?.fieldKey ?? f?.field_key ?? "").toString().toLowerCase();
      if (key === "telegram_user_id" || key === "telegramuserid") {
        const v = f?.value ?? f?.fieldValue ?? f?.field_value ?? null;
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v === "string" && v.trim().length > 0 && Number.isFinite(Number(v))) return Number(v);
      }
    }
  }

  return null;
}

/**
 * Read-only contact fetch used only as a fallback when webhook payload lacks telegram_user_id.
 *
 * IMPORTANT: Endpoint shapes vary by GHL plan/region; we keep this isolated so it's easy to adjust.
 */
export async function fetchTelegramUserIdByContactId(params: {
  env: Env;
  contactId: string;
}): Promise<number | null> {
  const { env, contactId } = params;
  if (!env.GHL_API_KEY) return null;

  const url = `${env.GHL_API_BASE_URL.replace(/\/$/, "")}/contacts/${encodeURIComponent(contactId)}`;
  const resp = await httpFetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.GHL_API_KEY}`,
      Accept: "application/json",
      Version: "2021-07-28"
    },
    timeoutMs: 10_000,
    maxRetries: 2,
    requestName: "ghl_contact_lookup"
  });

  if (!resp.ok) return null;
  const json = (await resp.json()) as any;
  const contact = json?.contact ?? json?.data?.contact ?? json?.data ?? json;
  return extractTelegramUserIdFromContact(contact);
}

