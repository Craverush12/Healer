import type { Context } from "telegraf";
import type { Env } from "../../config/env";
import type { SqliteDb } from "../../db/db";
import { applyStateTransition, getUser, upsertUserIfMissing } from "../../db/usersRepo";
import { buildMainMenuKeyboard } from "../menus";
import { logger } from "../../logger";

const CHECKOUT_PLACEHOLDER = "{telegram_user_id}";

export function buildCheckoutUrl(env: Env, telegramUserId: number): string {
  if (!env.GHL_CHECKOUT_URL_TEMPLATE) {
    throw new Error("GHL_CHECKOUT_URL_TEMPLATE not configured");
  }
  return env.GHL_CHECKOUT_URL_TEMPLATE.replace(CHECKOUT_PLACEHOLDER, encodeURIComponent(String(telegramUserId)));
}

export function getSampleCheckoutUrl(env: Env): string | null {
  if (!env.ENABLE_PAYMENTS || !env.GHL_CHECKOUT_URL_TEMPLATE) return null;
  return buildCheckoutUrl(env, 123456789);
}

export async function handleSubscribe(params: { ctx: Context; env: Env; db: SqliteDb }) {
  const { ctx, env, db } = params;
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) return;

  logger.info({ telegramUserId, paymentsEnabled: env.ENABLE_PAYMENTS }, "Handle subscribe request");

  upsertUserIfMissing(db, telegramUserId);
  const user = getUser(db, telegramUserId);

  if (!env.ENABLE_PAYMENTS) {
    applyStateTransition({
      db,
      telegramUserId,
      nextState: "ACTIVE_SUBSCRIBER",
      eventAt: Date.now(),
      ghlContactId: null
    });
    const updatedUser = getUser(db, telegramUserId);
    const keyboard = buildMainMenuKeyboard(updatedUser?.state ?? "ACTIVE_SUBSCRIBER", env);
    await ctx.reply(
      "Access granted! (Payments disabled - testing mode)\n\nYou can now browse the audio library. Use Start Here to begin!",
      keyboard
    );
    return;
  }

  if (user?.state === "ACTIVE_SUBSCRIBER" || user?.state === "CANCEL_PENDING") {
    await ctx.reply("You already have access. Use Manage Subscription for billing changes.");
    return;
  }

  const url = buildCheckoutUrl(env, telegramUserId);
  logger.info({ telegramUserId, checkoutUrl: url }, "Generated checkout URL");
  await ctx.reply(["Tap the link to subscribe:", url, "", "After checkout, access is granted automatically."].join("\n"));
}
