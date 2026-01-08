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
// Audio recovery is imported dynamically to ensure module is loaded when needed

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

  // Check audio availability on startup
  const audioItems = audio.manifest.items.filter(item => !item.type || item.type === "audio");
  const availableCount = audioItems.filter(item => {
    const dbFileId = db.prepare("SELECT telegram_file_id FROM telegram_audio_cache WHERE item_id = ?").get(item.id);
    return !!(dbFileId || item.telegramFileId);
  }).length;
  
  logger.info({
    totalAudio: audioItems.length,
    availableAudio: availableCount,
    missingAudio: audioItems.length - availableCount
  }, "Audio availability check");

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
    
    // Keep-alive mechanism for Render free tier (prevents container sleep)
    // Always enable on Render (Render sets NODE_ENV to production automatically)
    const keepAliveInterval = setInterval(() => {
      fetch(`http://localhost:${env.PORT}/healthz`)
        .then(() => {
          logger.info("Keep-alive ping successful"); // Changed to info for visibility
        })
        .catch((err) => {
          logger.error({ err }, "Keep-alive ping failed - app may sleep");
        });
    }, 4 * 60 * 1000); // Every 4 minutes (more frequent)
      
      logger.info("Keep-alive mechanism activated (4-minute intervals) - preventing Render sleep");
      
    
    // Clean up interval on shutdown
    const originalShutdown = shutdown;
    shutdown = (signal: string) => {
      clearInterval(keepAliveInterval);
      logger.info("Keep-alive mechanism deactivated");
      originalShutdown(signal);
    };
  });

  let shutdown = (signal: string) => {
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
      logger.info("Telegram bot launched successfully");
      
      // Notify admin of successful restart (optional)
      if (env.ADMIN_TELEGRAM_USER_IDS && env.ADMIN_TELEGRAM_USER_IDS.length > 0) {
        try {
          const restartTime = new Date().toISOString();
          logger.info({ adminIds: env.ADMIN_TELEGRAM_USER_IDS }, "Sending restart notification to admins");
          for (const adminId of env.ADMIN_TELEGRAM_USER_IDS) {
            await bot.telegram.sendMessage(
              adminId, 
              `🟢 Bot restarted successfully\nTime: ${restartTime}\nStatus: All systems operational`
            );
          }
          logger.info("Admin restart notifications sent");
        } catch (notifyErr) {
          logger.warn({ notifyErr }, "Failed to notify admin of restart");
        }
      }
      
      // Start audio recovery validation in background (after 15 seconds delay to ensure bot is fully ready)
      // Recovery will also happen on-demand when users request audio, so this is optional
      if (env.ADMIN_TELEGRAM_USER_IDS.length > 0) {
        logger.info({ delaySeconds: 15, adminCount: env.ADMIN_TELEGRAM_USER_IDS.length }, "Scheduling audio recovery validation");
        setTimeout(async () => {
          try {
            logger.info("🔄 Starting background audio recovery validation");
            // Use dynamic import like the manual command for consistency
            const { validateAndRecoverAudio } = await import("./content/audioRecovery");
            await validateAndRecoverAudio(bot, db, audio, env.ADMIN_TELEGRAM_USER_IDS);
            logger.info("✅ Audio recovery validation completed");
          } catch (err: any) {
            logger.error({ 
              err, 
              errorMessage: err?.message,
              errorCode: err?.response?.error_code,
              errorDescription: err?.response?.description,
              stack: err?.stack 
            }, "❌ Audio recovery validation failed with error");
          }
        }, 15000); // 15 second delay to ensure bot is fully ready
      } else {
        logger.info("No admin IDs configured - audio recovery will happen on-demand when users request audio");
      }
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
