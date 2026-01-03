import fs from "node:fs";

import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";

import type { AudioLibrary } from "../../content/library";
import { resolveAudioFilePath } from "../../content/storage";
import { getTelegramAudioFileId } from "../../db/audioCacheRepo";
import type { SqliteDb } from "../../db/db";
import { getUser } from "../../db/usersRepo";
import { logger } from "../../logger";

function hasAudioAccess(state: string | null | undefined): boolean {
  return state === "ACTIVE_SUBSCRIBER" || state === "CANCEL_PENDING";
}

export async function showCategories(params: { ctx: Context; db: SqliteDb; audio: AudioLibrary }) {
  const { ctx, db, audio } = params;
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) return;

  const user = getUser(db, telegramUserId);
  if (!user || !hasAudioAccess(user.state)) {
    await ctx.reply("Audio library is for subscribers only. Tap Subscribe to get access.");
    return;
  }

  const sortedCategories = [...audio.manifest.categories].sort((a, b) => {
    if (a.recommended && !b.recommended) return -1;
    if (!a.recommended && b.recommended) return 1;
    return a.title.localeCompare(b.title);
  });

  const buttons = sortedCategories.map((c) => {
    const label = c.recommended ? `★ ${c.title}` : c.title;
    return [Markup.button.callback(label, `audio:cat:${c.id}`)];
  });

  await ctx.reply("Choose a category:", Markup.inlineKeyboard(buttons));
}

export function registerAudioBrowseHandlers(bot: Telegraf, params: { db: SqliteDb; audio: AudioLibrary }) {
  const { db, audio } = params;

  bot.action(/^audio:cat:(.+)$/i, async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    await ctx.answerCbQuery();

    const user = getUser(db, telegramUserId);
    if (!user || !hasAudioAccess(user.state)) {
      await ctx.reply("Audio library is for subscribers only. Tap Subscribe to get access.");
      return;
    }

    const categoryId = ctx.match[1];
    const category = audio.categoriesById.get(categoryId);
    if (!category) {
      await ctx.reply("Unknown category.");
      return;
    }

    if (category.type === "text" && category.content) {
      const text = [
        category.title,
        "",
        category.content,
        category.usageInstructions ? `\n${category.usageInstructions}` : ""
      ]
        .filter(Boolean)
        .join("\n");

      await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("Back", "audio:back")]]));
      return;
    }

    const items = audio.itemsByCategoryId.get(categoryId) ?? [];
    if (items.length === 0) {
      const message = [
        category.title,
        category.description ? `\n${category.description}` : "",
        "",
        "Content coming soon!",
        category.usageInstructions ? `\n${category.usageInstructions}` : ""
      ]
        .filter(Boolean)
        .join("\n");

      await ctx.reply(message, Markup.inlineKeyboard([[Markup.button.callback("Back", "audio:back")]]));
      return;
    }

    const sortedItems = [...items].sort((a, b) => {
      if (a.recommended && !b.recommended) return -1;
      if (!a.recommended && b.recommended) return 1;
      return a.title.localeCompare(b.title);
    });

    const categoryHeader = [
      category.title,
      category.description ? `\n${category.description}` : "",
      category.usageInstructions ? `\n${category.usageInstructions}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    const buttons = sortedItems.map((item) => {
      let label = item.title;
      if (item.duration) label += ` (${item.duration})`;
      if (item.recommended) label = `★ ${label}`;
      return [Markup.button.callback(label, `audio:item:${item.id}`)];
    });
    buttons.push([Markup.button.callback("Back", "audio:back")]);

    await ctx.reply(categoryHeader, Markup.inlineKeyboard(buttons));
  });

  bot.action("audio:back", async (ctx) => {
    await ctx.answerCbQuery();
    await showCategories({ ctx, db, audio });
  });

  bot.action(/^audio:item:(.+)$/i, async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    await ctx.answerCbQuery();

    const user = getUser(db, telegramUserId);
    if (!user || !hasAudioAccess(user.state)) {
      await ctx.reply("Audio library is for subscribers only. Tap Subscribe to get access.");
      return;
    }

    const itemId = ctx.match[1];
    const item = audio.itemsById.get(itemId);
    if (!item) {
      await ctx.reply("Unknown item.");
      return;
    }

    if (item.type === "external" && item.url) {
      const message = [
        item.title,
        item.description ? `\n${item.description}` : "",
        item.duration ? `\nDuration: ${item.duration}` : "",
        item.whenToUse && item.whenToUse.length > 0 ? `\nBest for: ${item.whenToUse.join(", ")}` : "",
        "",
        item.url
      ]
        .filter(Boolean)
        .join("\n");

      await ctx.reply(
        message,
        Markup.inlineKeyboard([
          [Markup.button.url("Open link", item.url)],
          [Markup.button.callback("Back", `audio:cat:${item.categoryId}`)]
        ])
      );
      return;
    }

    if (item.type === "audio" || !item.type) {
      const captionParts = [];
      if (item.description) captionParts.push(item.description);
      if (item.duration) captionParts.push(`Duration: ${item.duration}`);
      if (item.whenToUse && item.whenToUse.length > 0) captionParts.push(`Best for: ${item.whenToUse.join(", ")}`);
      if (item.difficulty) captionParts.push(`Level: ${item.difficulty}`);
      const caption = captionParts.length > 0 ? captionParts.join("\n") : undefined;

      const cachedFileId = getTelegramAudioFileId(db, item.id);
      if (cachedFileId) {
        await ctx.replyWithAudio(cachedFileId, { title: item.title, caption });
        return;
      }

      if (!item.filePath) {
        await ctx.reply(`Sorry, "${item.title}" is not available yet.`);
        return;
      }

      try {
        const filePath = resolveAudioFilePath(item.filePath);
        await ctx.replyWithAudio({ source: fs.createReadStream(filePath) }, { title: item.title, caption });
      } catch (err: any) {
        logger.error({ err, itemId, filePath: item.filePath }, "Failed to send audio file");
        await ctx.reply(`Sorry, "${item.title}" is not available right now.`);
      }
      return;
    }

    await ctx.reply(`Sorry, "${item.title}" is not available.`);
  });
}

