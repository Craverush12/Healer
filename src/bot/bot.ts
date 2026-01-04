import fs from "node:fs";
import { Markup, Telegraf } from "telegraf";

import type { AudioLibrary } from "../content/library";
import { resolveAudioFilePath } from "../content/storage";
import type { Env } from "../config/env";
import { getTelegramAudioFileId, upsertTelegramAudioFileId } from "../db/audioCacheRepo";
import type { SqliteDb } from "../db/db";
import { getUser, upsertUserIfMissing } from "../db/usersRepo";
import { logger } from "../logger";
import { registerAudioBrowseHandlers, showCategories } from "./flows/audioBrowse";
import { registerCancelRetentionHandlers, startCancellationFlow } from "./flows/cancelRetention";
import { handleSubscribe } from "./flows/subscribe";
import { MENU_LABELS, buildMainMenuKeyboard, renderHelpText } from "./menus";

function hasAudioAccess(state: string | null | undefined): boolean {
  return state === "ACTIVE_SUBSCRIBER" || state === "CANCEL_PENDING";
}

function isAdmin(env: Env, telegramUserId: number): boolean {
  return env.ADMIN_TELEGRAM_USER_IDS.includes(telegramUserId);
}

export function createBot(params: { env: Env; db: SqliteDb; audio: AudioLibrary }) {
  const { env, db, audio } = params;

  const bot = new Telegraf(env.BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      const telegramUserId = ctx.from.id;
      upsertUserIfMissing(db, telegramUserId);
      const user = getUser(db, telegramUserId);

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
    if (!item.filePath) {
      await ctx.reply(`Item has no filePath: ${itemId}`);
      return;
    }

    const existing = getTelegramAudioFileId(db, itemId);
    if (existing) {
      await ctx.reply("Already cached for this item.");
      return;
    }
    if (item.telegramFileId) {
      await ctx.reply("Already has telegramFileId in manifest. Use that in production or clear it before re-ingesting.");
      return;
    }

    const fullPath = resolveAudioFilePath(item.filePath);
    await ctx.reply(`Uploading: ${item.title}`);
    const msg: any = await ctx.replyWithAudio({ source: fs.createReadStream(fullPath) }, { title: item.title });
    const telegramFileId: string | undefined = msg?.audio?.file_id;
    if (!telegramFileId) {
      await ctx.reply("Upload succeeded but could not extract telegram file_id.");
      return;
    }

    upsertTelegramAudioFileId(db, itemId, telegramFileId);
    await ctx.reply(
      [
        `Cached file_id for ${itemId}.`,
        "",
        "Copy this into audio/manifest.json to avoid needing a persistent DB in production:",
        `"telegramFileId": "${telegramFileId}"`
      ].join("\n")
    );
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
