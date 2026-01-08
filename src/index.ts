import "dotenv/config";

import express from "express";
import { createGhlWebhookRouter } from "./webhooks/ghlWebhookRouter";
import { createIpRateLimiter } from "./webhooks/rateLimit";
import { loadEnv } from "./config/env";
import { logger } from "./logger";
import { applySchema, openSqlite } from "./db/db";
import { SCHEMA_SQL } from "./db/schema";
import { loadAudioLibrary } from "./content/library";
import { createBot } from "./bot/bot";
import { getSampleCheckoutUrl } from "./bot/flows/subscribe";
import { initGhlClient } from "./ghl/ghlClient";

async function main() {
  const env = loadEnv(process.env);

  if (env.ENABLE_PAYMENTS) {
    const sampleCheckoutUrl = getSampleCheckoutUrl(env);
    if (sampleCheckoutUrl) {
      logger.info(
        { sampleCheckoutUrl },
        "Checkout template validated; sample URL shown with {telegram_user_id} placeholder substituted."
      );
    }

    logger.info(
      {
        baseUrl: env.GHL_API_BASE_URL,
        hasApiKey: !!env.GHL_API_KEY,
        hasLocationId: !!env.GHL_LOCATION_ID
      },
      "Resync configuration"
    );

    if (!env.GHL_API_KEY) {
      logger.warn("GHL_API_KEY missing; resync disabled, webhook-only mode.");
    } else {
      await initGhlClient(env);
    }
  }

  // SQLite init + schema
  const db = openSqlite(env.DB_PATH);
  applySchema(db, SCHEMA_SQL);
  logger.info({ dbPath: env.DB_PATH }, "SQLite ready");

  // Audio manifest (admin-managed)
  const audio = loadAudioLibrary();
  logger.info(
    { categories: audio.manifest.categories.length, items: audio.manifest.items.length },
    "Audio library loaded"
  );

  // Telegram bot
  const bot = createBot({ env, db, audio });

  // Express app (webhooks + health). Start this first so hosting platforms detect the port promptly.
  const app = express();

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Webhook endpoint needs raw body for signature verification.
  app.set("trust proxy", true);
  app.use(
    "/webhooks",
    createIpRateLimiter({
      windowMs: 60_000,
      max: 120
    })
  );
  app.use("/webhooks", express.raw({ type: "*/*" }));
  app.use(
    "/webhooks",
    createGhlWebhookRouter({
      env,
      db,
      sendTelegramMessage: async (telegramUserId, text) => {
        await bot.telegram.sendMessage(telegramUserId, text);
      }
    })
  );

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "HTTP server listening");
  });

  const shutdown = (signal: string) => {
    logger.warn({ signal }, "Shutting down...");
    bot.stop(signal);
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Launch bot after HTTP server is listening so container port is bound even if Telegram hangs.
  (async () => {
    try {
      logger.info("Launching Telegram bot");
      // Ensure we are in polling mode and not blocked by a lingering webhook.
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot.launch();
      logger.info("Telegram bot launched");
    } catch (err: any) {
      logger.error({ err, message: err?.message }, "Failed to launch Telegram bot");
      logger.error("Possible causes:");
      logger.error("1. Invalid BOT_TOKEN - check your .env file");
      logger.error("2. Network connectivity issues - check your internet connection");
      logger.error("3. Firewall blocking Telegram API - check firewall settings");
      logger.error("4. Telegram API temporarily unavailable - try again in a few minutes");
      // Exit so the process restarts rather than staying silent.
      process.exit(1);
    }
  })();
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
