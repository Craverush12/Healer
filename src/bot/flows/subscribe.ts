import type { Context } from "telegraf";
import type { Env } from "../../config/env";
import type { SqliteDb } from "../../db/db";
import { getUser, upsertUserIfMissing, applyStateTransition } from "../../db/usersRepo";
import { buildMainMenuKeyboard } from "../menus";

export function buildCheckoutUrl(env: Env, telegramUserId: number): string {
  // Admin supplies the correct GHL prefill parameter name; we just substitute safely.
  if (!env.GHL_CHECKOUT_URL_TEMPLATE) {
    throw new Error("GHL_CHECKOUT_URL_TEMPLATE not configured");
  }
  return env.GHL_CHECKOUT_URL_TEMPLATE.replace("{telegram_user_id}", encodeURIComponent(String(telegramUserId)));
}

export async function handleSubscribe(params: { ctx: Context; env: Env; db: SqliteDb }) {
  const { ctx, env, db } = params;
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) return;

  upsertUserIfMissing(db, telegramUserId);
  const user = getUser(db, telegramUserId);

  // If payments are disabled, grant access immediately for testing
  if (!env.ENABLE_PAYMENTS) {
    // For testing: automatically grant access
    applyStateTransition({
      db,
      telegramUserId,
      nextState: "ACTIVE_SUBSCRIBER",
      eventAt: Date.now(),
      ghlContactId: null
    });
    const updatedUser = getUser(db, telegramUserId);
    // Note: We don't have audio library access here, so pass undefined
    const keyboard = buildMainMenuKeyboard(updatedUser?.state ?? "ACTIVE_SUBSCRIBER", env);
    await ctx.reply(
      "✅ Access granted! (Payments disabled - testing mode)\n\nYou can now browse the audio library. Use ⭐ Start Here to begin!",
      keyboard
    );
    return;
  }

  if (user?.state === "ACTIVE_SUBSCRIBER" || user?.state === "CANCEL_PENDING") {
    await ctx.reply("You already have access. Use ⚙️ Manage Subscription for billing changes.");
    return;
  }

  const url = buildCheckoutUrl(env, telegramUserId);
  await ctx.reply(["Tap the link to subscribe:", url, "", "After checkout, access is granted automatically."].join("\n"));
}

