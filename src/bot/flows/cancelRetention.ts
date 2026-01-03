import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";
import type { Env } from "../../config/env";
import type { SqliteDb } from "../../db/db";
import { getUser, setCancelReason } from "../../db/usersRepo";

function isSubscriberState(state: string | null | undefined): boolean {
  return state === "ACTIVE_SUBSCRIBER" || state === "CANCEL_PENDING";
}

export async function startCancellationFlow(params: { ctx: Context; db: SqliteDb; env?: Env }) {
  const { ctx, db, env } = params;
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) return;

  if (!env?.ENABLE_PAYMENTS) {
    await ctx.reply("Payment features are disabled. This is a testing environment.");
    return;
  }

  const user = getUser(db, telegramUserId);
  if (!user || !isSubscriberState(user.state)) {
    await ctx.reply("You don't have an active subscription to cancel. Tap 💳 Subscribe to get access.");
    return;
  }

  if (user.state === "CANCEL_PENDING") {
    await ctx.reply("Your subscription is already scheduled to cancel at the end of the billing cycle.");
  }

  const reasonKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("Too expensive", "cancel:reason:too_expensive")],
    [Markup.button.callback("Not using it enough", "cancel:reason:not_using")],
    [Markup.button.callback("Content not helpful", "cancel:reason:not_helpful")],
    [Markup.button.callback("Other", "cancel:reason:other")]
  ]);

  await ctx.reply("Before you go — what's the main reason?", reasonKeyboard);
}

export function registerCancelRetentionHandlers(
  bot: Telegraf,
  params: { env: Env; db: SqliteDb }
) {
  const { env, db } = params;

  bot.action(/^cancel:reason:(.+)$/i, async (ctx) => {
    if (!env.ENABLE_PAYMENTS) {
      await ctx.answerCbQuery("Payments disabled");
      return;
    }

    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const user = getUser(db, telegramUserId);
    if (!user || !isSubscriberState(user.state)) {
      await ctx.answerCbQuery("No active subscription.");
      await ctx.reply("You don't have an active subscription to cancel.");
      return;
    }

    const reason = ctx.match[1];
    setCancelReason(db, telegramUserId, reason);

    await ctx.answerCbQuery();
    await ctx.reply(
      [
        "We'd love to keep you.",
        "",
        "If you stay, here's a discount that applies from your NEXT billing cycle only (no proration, no refunds):",
        `Coupon code: ${env.RETENTION_COUPON_CODE}`,
        "",
        "Choose an option:"
      ].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Accept discount", "cancel:accept_discount")],
        [Markup.button.callback("❌ Continue to cancel", "cancel:continue_cancel")]
      ])
    );
  });

  bot.action("cancel:accept_discount", async (ctx) => {
    if (!env.ENABLE_PAYMENTS) {
      await ctx.answerCbQuery("Payments disabled");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.reply(
      [
        "Great — apply the coupon in your subscription portal.",
        `Coupon code: ${env.RETENTION_COUPON_CODE}`,
        "",
        "Manage subscription here:",
        env.MANAGE_SUBSCRIPTION_URL
      ].join("\n")
    );
  });

  bot.action("cancel:continue_cancel", async (ctx) => {
    if (!env.ENABLE_PAYMENTS) {
      await ctx.answerCbQuery("Payments disabled");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.reply(
      [
        "To finish cancelling, use the subscription portal:",
        env.MANAGE_SUBSCRIPTION_URL,
        "",
        "Important:",
        "- Cancel at period end (no refunds, no proration).",
        "- You will keep access until the end of the current billing cycle.",
        "- Access will be revoked automatically when we receive the cancellation webhook."
      ].join("\n")
    );
  });
}

