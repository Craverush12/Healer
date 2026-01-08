import { Telegraf } from "telegraf";
import type { AudioLibrary } from "./library";
import { getTelegramAudioFileId, upsertTelegramAudioFileId } from "../db/audioCacheRepo";
import type { SqliteDb } from "../db/db";
import { logger } from "../logger";

const TELEGRAM_AUDIO_LIMIT_BYTES = 49 * 1024 * 1024; // 50MB limit

/**
 * Tests if a Telegram file_id is still valid by attempting to get file info.
 */
async function testTelegramFileId(bot: Telegraf, fileId: string): Promise<boolean> {
  try {
    await bot.telegram.getFile(fileId);
    return true;
  } catch (err: any) {
    const errorCode = err?.response?.error_code;
    const description = String(err?.response?.description ?? err?.message ?? "").toLowerCase();
    
    // File ID is invalid if we get a 400 error with "wrong file identifier"
    if (errorCode === 400 && description.includes("wrong file identifier")) {
      return false;
    }
    
    // Other errors might be temporary, assume valid
    logger.warn({ err, fileId }, "File ID test returned unexpected error, assuming valid");
    return true;
  }
}

/**
 * Downloads an audio file from Google Drive.
 */
async function downloadFromGoogleDrive(url: string): Promise<Buffer> {
  logger.info({ url }, "Downloading audio from Google Drive");
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Google Drive download failed: ${response.status} ${response.statusText}`);
  }
  
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  logger.info({ url, sizeBytes: buffer.length }, "Downloaded audio from Google Drive");
  return buffer;
}

/**
 * Uploads audio buffer to Telegram and returns the file_id.
 */
async function uploadToTelegram(
  bot: Telegraf,
  buffer: Buffer,
  title: string,
  itemId: string
): Promise<string> {
  logger.info({ itemId, title, sizeBytes: buffer.length }, "Uploading audio to Telegram");
  
  // Check size limit
  if (buffer.length > TELEGRAM_AUDIO_LIMIT_BYTES) {
    throw new Error(`Audio file too large: ${Math.ceil(buffer.length / (1024 * 1024))}MB exceeds Telegram's 50MB limit`);
  }
  
  // Upload to Telegram (we need to send to a chat, so we'll use a temporary approach)
  // Note: We'll need to send it to the bot's admin or a test chat
  // For now, we'll use a workaround: create a temporary file and upload
  
  // Create a temporary readable stream from buffer
  const { Readable } = await import("stream");
  const stream = Readable.from(buffer);
  
  // We need a chat ID to send to - this will be handled by the caller
  // For now, return a placeholder - the actual implementation will need admin chat ID
  throw new Error("Upload requires admin chat ID - will be implemented in recovery function");
}

/**
 * Recovers a single audio item from Google Drive if its file_id is invalid.
 */
async function recoverAudioItem(
  bot: Telegraf,
  db: SqliteDb,
  item: { id: string; title: string; googleDriveUrl?: string },
  adminChatId: number
): Promise<boolean> {
  if (!item.googleDriveUrl) {
    logger.debug({ itemId: item.id }, "No Google Drive URL available for recovery");
    return false;
  }
  
  try {
    // Download from Google Drive
    const audioBuffer = await downloadFromGoogleDrive(item.googleDriveUrl);
    
    // Upload to Telegram
    logger.info({ itemId: item.id, title: item.title }, "Uploading recovered audio to Telegram");
    
    const { Readable } = await import("stream");
    const stream = Readable.from(audioBuffer);
    
    const message = await bot.telegram.sendAudio(
      adminChatId,
      { source: stream },
      { title: item.title }
    );
    
    const newFileId = message.audio?.file_id;
    if (!newFileId) {
      logger.error({ itemId: item.id }, "Upload succeeded but no file_id returned");
      return false;
    }
    
    // Cache the new file ID
    upsertTelegramAudioFileId(db, item.id, newFileId);
    logger.info({ itemId: item.id, newFileId }, "Audio recovered and cached successfully");
    
    return true;
  } catch (err: any) {
    logger.error({ err, itemId: item.id }, "Audio recovery failed");
    return false;
  }
}

/**
 * Validates and recovers all audio items on startup.
 * Runs in background after bot initialization.
 */
export async function validateAndRecoverAudio(
  bot: Telegraf,
  db: SqliteDb,
  audio: AudioLibrary,
  adminChatIds: number[]
): Promise<void> {
  logger.info({
    adminChatIdsCount: adminChatIds.length,
    adminChatIds: adminChatIds,
    audioItemsCount: audio.manifest.items.length
  }, "🔄 validateAndRecoverAudio called - entry point");
  
  if (adminChatIds.length === 0) {
    logger.error("❌ No admin chat IDs provided, skipping audio recovery validation");
    return;
  }
  
  const adminChatId = adminChatIds[0]; // Use first admin for uploads
  logger.info({ adminChatId, totalAdmins: adminChatIds.length }, "Using admin chat ID for uploads");
  
  logger.info("🔄 Starting audio file ID validation and recovery");
  
  const audioItems = audio.manifest.items.filter(item => !item.type || item.type === "audio");
  logger.info({
    totalItems: audio.manifest.items.length,
    audioItemsCount: audioItems.length,
    audioItemIds: audioItems.map(i => i.id)
  }, "Filtered audio items for recovery");
  
  let validated = 0;
  let recovered = 0;
  let failed = 0;
  let skipped = 0;
  
  for (const item of audioItems) {
    const cachedFileId = getTelegramAudioFileId(db, item.id);
    const manifestFileId = item.telegramFileId;
    const fileIdToTest = cachedFileId ?? manifestFileId;
    
    // Case 1: No file ID at all - recover from Google Drive if available
    if (!fileIdToTest) {
      if (item.googleDriveUrl) {
        logger.info({ itemId: item.id, title: item.title }, "No file ID found, recovering from Google Drive");
        const success = await recoverAudioItem(bot, db, item, adminChatId);
        if (success) {
          recovered++;
        } else {
          failed++;
        }
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        logger.debug({ itemId: item.id }, "No file ID and no Google Drive URL - skipping");
      }
      continue;
    }
    
    // Case 2: File ID exists - validate it
    validated++;
    logger.debug({ itemId: item.id, fileId: fileIdToTest }, "Validating file ID");
    
    const isValid = await testTelegramFileId(bot, fileIdToTest);
    
    if (!isValid) {
      logger.warn({ itemId: item.id, fileId: fileIdToTest }, "File ID invalid, attempting recovery from Google Drive");
      
      if (item.googleDriveUrl) {
        const success = await recoverAudioItem(bot, db, item, adminChatId);
        if (success) {
          recovered++;
        } else {
          failed++;
        }
      } else {
        logger.warn({ itemId: item.id }, "File ID invalid but no Google Drive URL available for recovery");
        failed++;
      }
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      logger.debug({ itemId: item.id }, "File ID valid");
    }
  }
  
  logger.info({
    total: audioItems.length,
    validated,
    recovered,
    failed,
    skipped: audioItems.length - validated
  }, "Audio validation and recovery complete");
  
  // Notify admins of recovery results
  if (recovered > 0 || failed > 0) {
    const message = [
      "🔄 **Audio Recovery Report**",
      "",
      `✅ Validated: ${validated}`,
      `🔄 Recovered: ${recovered}`,
      `❌ Failed: ${failed}`
    ].join("\n");
    
    for (const adminId of adminChatIds) {
      try {
        await bot.telegram.sendMessage(adminId, message);
      } catch (err) {
        logger.warn({ err, adminId }, "Failed to notify admin of recovery results");
      }
    }
  }
}
