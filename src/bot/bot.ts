import fs from "node:fs";
import { Markup, Telegraf } from "telegraf";

import type { AudioLibrary } from "../content/library";
import { resolveAudioFilePath } from "../content/storage";
import type { Env } from "../config/env";
import {
  clearTelegramAudioFileIds,
  deleteTelegramAudioFileId,
  getTelegramAudioFileId,
  upsertTelegramAudioFileId
} from "../db/audioCacheRepo";
import type { SqliteDb } from "../db/db";
import {
  applyStateTransition,
  getUser,
  setGhlContactId,
  setLastResyncAt,
  upsertUserIfMissing,
  type UserState
} from "../db/usersRepo";
import { logger } from "../logger";
import { registerAudioBrowseHandlers, showCategories } from "./flows/audioBrowse";
import { registerCancelRetentionHandlers, startCancellationFlow } from "./flows/cancelRetention";
import { handleSubscribe } from "./flows/subscribe";
import { MENU_LABELS, buildMainMenuKeyboard, renderHelpText } from "./menus";
import { findContactByTelegramUserId, getSubscriptionStatusForContact } from "../ghl/ghlClient";

function hasAudioAccess(state: string | null | undefined): boolean {
  return state === "ACTIVE_SUBSCRIBER" || state === "CANCEL_PENDING";
}

function isAdmin(env: Env, telegramUserId: number): boolean {
  return env.ADMIN_TELEGRAM_USER_IDS.includes(telegramUserId);
}

function mapSubscriptionToState(status: {
  isActive: boolean;
  cancelAtPeriodEnd: boolean;
  ended: boolean;
}): UserState | null {
  if (status.isActive && status.cancelAtPeriodEnd) return "CANCEL_PENDING";
  if (status.isActive) return "ACTIVE_SUBSCRIBER";
  if (status.ended) return "CANCELLED";
  return null;
}

function buildResyncMessage(state: UserState): string {
  if (state === "ACTIVE_SUBSCRIBER") {
    return "Subscription detected and synced. You now have access to the audio library.";
  }
  if (state === "CANCEL_PENDING") {
    return "Subscription detected and synced. Cancellation is scheduled at period end.";
  }
  return "Subscription status synced. Access remains revoked.";
}

async function resyncFromGhl(params: {
  env: Env;
  db: SqliteDb;
  telegramUserId: number;
  force?: boolean;
  source: "start" | "command";
}) {
  const { env, db, telegramUserId, force, source } = params;

  if (!env.ENABLE_PAYMENTS) {
    logger.info({ telegramUserId, source }, "Resync skipped (payments disabled)");
    return { attempted: false, skipped: "payments_disabled" as const };
  }

  if (!env.GHL_API_KEY) {
    logger.info({ telegramUserId, source }, "Resync skipped (no GHL_API_KEY; webhook-only mode)");
    return { attempted: false, skipped: "no_api_key" as const };
  }

  const user = getUser(db, telegramUserId);
  if (!user) {
    logger.warn({ telegramUserId, source }, "Resync skipped (user missing)");
    return { attempted: false, skipped: "no_user" as const };
  }

  if (user.state === "ACTIVE_SUBSCRIBER" || user.state === "CANCEL_PENDING") {
    logger.info({ telegramUserId, source, state: user.state }, "Resync skipped (state already active)");
    return { attempted: false, skipped: "already_active" as const };
  }

  const now = Date.now();
  const cooldownMs = env.RESYNC_COOLDOWN_MINUTES * 60 * 1000;
  const lastResyncAt = user.last_resync_at ?? null;
  if (!force && cooldownMs > 0 && lastResyncAt && now - lastResyncAt < cooldownMs) {
    logger.info(
      { telegramUserId, source, lastResyncAt, cooldownMs },
      "Resync skipped (cooldown)"
    );
    return { attempted: false, skipped: "cooldown" as const };
  }

  logger.info({ telegramUserId, source, force: !!force }, "Resync started");

  const contact = await findContactByTelegramUserId({ env, telegramUserId });
  if (!contact) {
    setLastResyncAt(db, telegramUserId, now);
    logger.info({ telegramUserId, source }, "Resync: no contact found");
    return { attempted: true, skipped: "no_contact" as const };
  }

  setGhlContactId(db, telegramUserId, contact.contactId);
  logger.info({ telegramUserId, contactId: contact.contactId, source }, "Resync: contact linked");

  const subscription = await getSubscriptionStatusForContact({ env, contactId: contact.contactId });
  setLastResyncAt(db, telegramUserId, now);

  if (!subscription) {
    logger.info({ telegramUserId, contactId: contact.contactId, source }, "Resync: subscription lookup failed");
    return { attempted: true, skipped: "no_subscription_data" as const };
  }

  const nextState = mapSubscriptionToState(subscription);
  if (!nextState) {
    logger.info({ telegramUserId, contactId: contact.contactId, source }, "Resync: no active subscription");
    return { attempted: true, skipped: "no_active_subscription" as const };
  }

  const applied = applyStateTransition({
    db,
    telegramUserId,
    nextState,
    eventAt: null,
    ghlContactId: contact.contactId
  });

  logger.info(
    {
      telegramUserId,
      contactId: contact.contactId,
      source,
      nextState,
      applied,
      subscriptionSource: subscription.source,
      subscriptionCount: subscription.count
    },
    "Resync: state evaluation complete"
  );

  return { attempted: true, nextState: applied ? nextState : null };
}

export function createBot(params: { env: Env; db: SqliteDb; audio: AudioLibrary }) {
  const { env, db, audio } = params;

  const bot = new Telegraf(env.BOT_TOKEN);
  const pendingIngest = new Map<number, string>();

  bot.start(async (ctx) => {
    try {
      const telegramUserId = ctx.from.id;
      logger.info({ telegramUserId }, "Telegram /start");
      upsertUserIfMissing(db, telegramUserId);
      let user = getUser(db, telegramUserId);

      if (user && (user.state === "NOT_SUBSCRIBED" || user.state === "CANCELLED")) {
        const resyncResult = await resyncFromGhl({
          env,
          db,
          telegramUserId,
          source: "start"
        });

        if (resyncResult.attempted) {
          user = getUser(db, telegramUserId);
          if (resyncResult.nextState && user && user.state === resyncResult.nextState) {
            await ctx.reply(buildResyncMessage(user.state));
          }
        }
      }

      const keyboard = buildMainMenuKeyboard(user?.state ?? "NOT_SUBSCRIBED", env, audio);
      const welcomeText = [
        "Welcome to Peace of Mind!",
        "",
        "Your personal meditation and mindfulness library.",
        "",
        "Use the menu below to get started."
      ].join("\n");

      await ctx.reply(welcomeText, keyboard);
    } catch (err) {
      logger.error({ err }, "Error in start command");
      await ctx.reply("Sorry, there was an error. Please try again.");
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(renderHelpText());
  });

  bot.command("subscribe", async (ctx) => {
    await handleSubscribe({ ctx, env, db });
  });

  bot.command("resync", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const text = (ctx.message as any)?.text ?? "";
    const parts = String(text).trim().split(/\s+/);
    const force = parts[1]?.toLowerCase() === "force";
    const canForce = force && isAdmin(env, telegramUserId);

    if (force && !canForce) {
      await ctx.reply("Force resync is admin-only.");
      return;
    }

    const result = await resyncFromGhl({
      env,
      db,
      telegramUserId,
      source: "command",
      force: canForce
    });

    if (!result.attempted) {
      if (result.skipped === "payments_disabled") {
        await ctx.reply("Payments are disabled. Resync not required.");
        return;
      }
      if (result.skipped === "no_api_key") {
        await ctx.reply("Resync is not configured yet (missing GHL API key).");
        return;
      }
      if (result.skipped === "cooldown") {
        await ctx.reply("Resync was run recently. Try again in a few minutes.");
        return;
      }
      if (result.skipped === "already_active") {
        await ctx.reply("Your subscription is already active.");
        return;
      }
      await ctx.reply("Resync skipped.");
      return;
    }

    if (result.nextState) {
      await ctx.reply(buildResyncMessage(result.nextState));
      return;
    }

    if (result.skipped === "no_contact") {
      await ctx.reply("No billing profile found for your Telegram account.");
      return;
    }
    if (result.skipped === "no_active_subscription") {
      await ctx.reply("No active subscription found.");
      return;
    }

    await ctx.reply("Resync completed.");
  });

  bot.command("browse", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    upsertUserIfMissing(db, telegramUserId);
    await showCategories({ ctx, db, audio });
  });

  bot.command("admin_ingest", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    if (!isAdmin(env, telegramUserId)) {
      await ctx.reply("Unauthorized.");
      return;
    }

    const text = (ctx.message as any)?.text ?? "";
    const parts = String(text).trim().split(/\s+/);
    const itemId = parts[1];
    if (!itemId) {
      await ctx.reply("Usage: /admin_ingest <itemId>");
      return;
    }

    const item = audio.itemsById.get(itemId);
    if (!item) {
      await ctx.reply(`Unknown item id: ${itemId}`);
      return;
    }
    if (item.type && item.type !== "audio") {
      await ctx.reply("This item is not an audio file.");
      return;
    }

    pendingIngest.set(telegramUserId, itemId);
    logger.info({ telegramUserId, itemId }, "Admin ingest requested; awaiting audio upload");

    const existing = getTelegramAudioFileId(db, itemId);
    const manifestFileId = item.telegramFileId;
    const notice =
      existing || manifestFileId
        ? "Note: existing file_id will be replaced."
        : "No existing file_id found for this item.";

    await ctx.reply(
      [
        `Send the MP3 for "${item.title}" now as an AUDIO upload (not document/voice).`,
        notice
      ].join("\n")
    );
  });

  bot.on("audio", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    if (!isAdmin(env, telegramUserId)) return;

    const itemId = pendingIngest.get(telegramUserId);
    if (!itemId) return;

    const item = audio.itemsById.get(itemId);
    if (!item || (item.type && item.type !== "audio")) {
      pendingIngest.delete(telegramUserId);
      await ctx.reply("Pending ingest item is invalid or not an audio file.");
      return;
    }

    const audioMsg: any = (ctx.message as any)?.audio;
    const telegramFileId: string | undefined = audioMsg?.file_id;
    if (!telegramFileId) {
      await ctx.reply("Could not read file_id from the audio message.");
      return;
    }

    upsertTelegramAudioFileId(db, itemId, telegramFileId);
    pendingIngest.delete(telegramUserId);
    logger.info({ telegramUserId, itemId, telegramFileId }, "Admin ingest stored file_id");

    await ctx.reply(
      [
        `Cached file_id for ${itemId}.`,
        "",
        "Copy this into audio/manifest.json to avoid needing a persistent DB in production:",
        `"telegramFileId": "${telegramFileId}"`
      ].join("\n")
    );
  });

  bot.on("voice", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    if (!isAdmin(env, telegramUserId)) return;
    if (!pendingIngest.has(telegramUserId)) return;
    await ctx.reply("Please upload the MP3 as an audio file (not voice).");
  });

  bot.on("document", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    if (!isAdmin(env, telegramUserId)) return;
    if (!pendingIngest.has(telegramUserId)) return;
    await ctx.reply("Please upload the MP3 as an audio file (not document).");
  });

  bot.command("admin_missing_file_ids", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    if (!isAdmin(env, telegramUserId)) {
      await ctx.reply("Unauthorized.");
      return;
    }

    const missing: string[] = [];
    for (const item of audio.manifest.items) {
      if (item.type && item.type !== "audio") continue;
      const cached = getTelegramAudioFileId(db, item.id);
      const manifestFileId = item.telegramFileId;
      if (!cached && !manifestFileId) missing.push(item.id);
    }

    if (missing.length === 0) {
      await ctx.reply("All audio items have cached Telegram file_ids.");
      return;
    }
    await ctx.reply(["Missing cached file_ids:", ...missing.map((id) => `- ${id}`)].join("\n"));
  });

  bot.command("admin_file_ids", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    if (!isAdmin(env, telegramUserId)) {
      await ctx.reply("Unauthorized.");
      return;
    }

    const lines: string[] = [];
    for (const item of audio.manifest.items) {
      if (item.type && item.type !== "audio") continue;
      const cached = getTelegramAudioFileId(db, item.id);
      const manifestFileId = item.telegramFileId;
      const chosen = cached ?? manifestFileId;
      lines.push(
        [
          `${item.id}:`,
          chosen ? `using=${chosen}` : "MISSING",
          manifestFileId ? `manifest=${manifestFileId}` : null,
          cached ? `db=${cached}` : null
        ]
          .filter(Boolean)
          .join(" | ")
      );
    }

    if (lines.length === 0) {
      await ctx.reply("No audio items found in manifest.");
      return;
    }

    // Keep reply concise; Telegraf limit is generous but avoid overlong messages.
    await ctx.reply(lines.join("\n"));
  });

  bot.command("admin_ingest_missing", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    if (!isAdmin(env, telegramUserId)) {
      await ctx.reply("Unauthorized.");
      return;
    }

    const missing: string[] = [];
    for (const item of audio.manifest.items) {
      if (item.type && item.type !== "audio") continue;
      const cached = getTelegramAudioFileId(db, item.id);
      const manifestFileId = item.telegramFileId;
      if (!cached && !manifestFileId) missing.push(item.id);
    }

    if (missing.length === 0) {
      await ctx.reply("All audio items have cached Telegram file_ids.");
      return;
    }

    await ctx.reply(`Ingesting ${missing.length} item(s)...`);

    for (const itemId of missing) {
      const item = audio.itemsById.get(itemId);
      if (!item || item.type === "external") continue;
      if (!item.filePath) {
        await ctx.reply(`Skipping ${itemId} (no filePath).`);
        continue;
      }

      try {
        const fullPath = resolveAudioFilePath(item.filePath);
        await ctx.reply(`Uploading: ${item.title}`);
        const msg: any = await ctx.replyWithAudio({ source: fs.createReadStream(fullPath) }, { title: item.title });
        const telegramFileId: string | undefined = msg?.audio?.file_id;
        if (!telegramFileId) {
          await ctx.reply(`Upload ok but could not extract file_id for ${itemId}.`);
          continue;
        }
        upsertTelegramAudioFileId(db, itemId, telegramFileId);
        await ctx.reply(`Cached file_id for ${itemId}: "telegramFileId": "${telegramFileId}"`);
      } catch (err: any) {
        logger.error({ err, itemId }, "Auto-ingest failed");
        await ctx.reply(`Failed to ingest ${itemId}: ${err?.message ?? err}`);
      }
    }

    await ctx.reply("Auto-ingest complete.");
  });

  bot.command("admin_export_manifest_ids", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    if (!isAdmin(env, telegramUserId)) {
      await ctx.reply("Unauthorized.");
      return;
    }

    const lines: string[] = [];
    lines.push("{");
    for (const item of audio.manifest.items) {
      if (item.type && item.type !== "audio") continue;
      const cached = getTelegramAudioFileId(db, item.id);
      const manifestFileId = item.telegramFileId;
      const useId = cached ?? manifestFileId;
      if (!useId) continue;
      lines.push(`  "${item.id}": "${useId}",`);
    }
    lines.push("}");

    await ctx.reply(["Paste these telegramFileId values into audio/manifest.json:", "```", ...lines, "```"].join("\n"));
  });

  bot.command("admin_clear_file_ids", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    if (!isAdmin(env, telegramUserId)) {
      await ctx.reply("Unauthorized.");
      return;
    }

    // Optional: allow clearing a single item by id
    const text = (ctx.message as any)?.text ?? "";
    const parts = String(text).trim().split(/\s+/);
    const itemId = parts[1];

    if (itemId) {
      deleteTelegramAudioFileId(db, itemId);
      await ctx.reply(`Cleared cached file_id for ${itemId}.`);
      return;
    }

    clearTelegramAudioFileIds(db);
    await ctx.reply("Cleared all cached Telegram file_ids from DB. Re-ingest to populate with the current bot token.");
  });

  bot.hears(MENU_LABELS.help, async (ctx) => {
    await ctx.reply(renderHelpText());
  });

  bot.hears(MENU_LABELS.subscribe, async (ctx) => {
    await handleSubscribe({ ctx, env, db });
  });

  bot.hears(MENU_LABELS.manage, async (ctx) => {
    if (!env.ENABLE_PAYMENTS) {
      await ctx.reply("Payment features are disabled. This is a testing environment.");
      return;
    }
    await ctx.reply(["Manage your subscription here:", env.MANAGE_SUBSCRIPTION_URL].join("\n"));
  });

  bot.hears(MENU_LABELS.cancel, async (ctx) => {
    if (!env.ENABLE_PAYMENTS) {
      await ctx.reply("Payment features are disabled. This is a testing environment.");
      return;
    }
    await startCancellationFlow({ ctx, db, env });
  });

  bot.hears(MENU_LABELS.browse, async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    upsertUserIfMissing(db, telegramUserId);
    await showCategories({ ctx, db, audio });
  });

  bot.action("menu:subscribe", async (ctx) => {
    await ctx.answerCbQuery();
    await handleSubscribe({ ctx, env, db });
  });

  bot.action("menu:browse", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    upsertUserIfMissing(db, telegramUserId);
    await showCategories({ ctx, db, audio });
  });

  bot.action("menu:manage", async (ctx) => {
    await ctx.answerCbQuery();
    if (!env.ENABLE_PAYMENTS) {
      await ctx.reply("Payment features are disabled. This is a testing environment.");
      return;
    }
    await ctx.reply(["Manage your subscription here:", env.MANAGE_SUBSCRIPTION_URL].join("\n"));
  });

  bot.action("menu:cancel", async (ctx) => {
    await ctx.answerCbQuery();
    if (!env.ENABLE_PAYMENTS) {
      await ctx.reply("Payment features are disabled. This is a testing environment.");
      return;
    }
    await startCancellationFlow({ ctx, db, env });
  });

  bot.action("menu:help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(renderHelpText());
  });

  bot.action("menu:start-here", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const user = getUser(db, telegramUserId);
    if (!user || !hasAudioAccess(user.state)) {
      await ctx.reply("Audio library is for subscribers only. Tap Subscribe to get access.");
      return;
    }

    const recommendedCategory = audio.manifest.categories.find((c: any) => c.recommended);
    const recommendedItem = audio.manifest.items.find((i: any) => i.recommended);

    if (recommendedCategory) {
      const categoryId = recommendedCategory.id;
      const items = audio.itemsByCategoryId.get(categoryId) ?? [];

      if (items.length > 0) {
        const sortedItems = [...items].sort((a: any, b: any) => {
          if (a.recommended && !b.recommended) return -1;
          if (!a.recommended && b.recommended) return 1;
          return a.title.localeCompare(b.title);
        });

        const categoryHeader = [
          recommendedCategory.title,
          recommendedCategory.description ? `\n${recommendedCategory.description}` : "",
          recommendedCategory.usageInstructions ? `\n${recommendedCategory.usageInstructions}` : ""
        ]
          .filter(Boolean)
          .join("\n");

        const buttons = sortedItems.map((item: any) => {
          let label = item.title;
          if (item.duration) label += ` (${item.duration})`;
          if (item.recommended) label = `Start Here: ${label}`;
          return [Markup.button.callback(label, `audio:item:${item.id}`)];
        });
        buttons.push([Markup.button.callback("Back to Browse", "menu:browse")]);

        await ctx.reply(categoryHeader, Markup.inlineKeyboard(buttons));
        return;
      }
    }

    if (recommendedItem) {
      await ctx.reply(
        `Start Here: ${recommendedItem.title}`,
        Markup.inlineKeyboard([[Markup.button.callback("Play", `audio:item:${recommendedItem.id}`)]])
      );
      return;
    }

    await showCategories({ ctx, db, audio });
  });

  registerAudioBrowseHandlers(bot, { db, audio });
  registerCancelRetentionHandlers(bot, { env, db });

  bot.catch((err, ctx) => {
    logger.error({ err, updateId: ctx.update.update_id }, "Bot handler error");
  });

  return bot;
}
