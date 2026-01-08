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
  logger.debug({ fileId }, "🧪 Testing Telegram file ID validity");
  
  try {
    const fileInfo = await bot.telegram.getFile(fileId);
    logger.debug({ fileId, fileSize: fileInfo.file_size }, "✅ File ID test successful - file exists");
    return true;
  } catch (err: any) {
    const errorCode = err?.response?.error_code;
    const description = String(err?.response?.description ?? err?.message ?? "").toLowerCase();
    
    logger.debug({
      fileId,
      errorCode,
      description,
      errorMessage: err?.message
    }, "File ID test returned error");
    
    // File ID is invalid if we get a 400 error with "wrong file identifier"
    if (errorCode === 400 && description.includes("wrong file identifier")) {
      logger.warn({ fileId, errorCode, description }, "❌ File ID invalid - wrong file identifier");
      return false;
    }
    
    // Other errors might be temporary, assume valid
    logger.warn({ err, fileId, errorCode, description }, "⚠️ File ID test returned unexpected error, assuming valid");
    return true;
  }
}

/**
 * Downloads an audio file from Google Drive.
 */
async function downloadFromGoogleDrive(url: string): Promise<Buffer> {
  logger.info({ url }, "📥 Starting download from Google Drive");
  const startTime = Date.now();
  
  try {
    logger.debug({ url }, "Sending fetch request to Google Drive");
    const response = await fetch(url);
    
    logger.info({
      url,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length")
    }, "Google Drive response received");
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unable to read error response");
      logger.error({
        url,
        status: response.status,
        statusText: response.statusText,
        errorText
      }, "❌ Google Drive download failed");
      throw new Error(`Google Drive download failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    logger.debug({ url }, "Reading response as array buffer");
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const downloadTime = Date.now() - startTime;
    
    logger.info({
      url,
      sizeBytes: buffer.length,
      sizeMB: Math.round((buffer.length / (1024 * 1024)) * 100) / 100,
      downloadTimeMs: downloadTime
    }, "✅ Downloaded audio from Google Drive successfully");
    
    return buffer;
  } catch (err: any) {
    logger.error({
      err,
      url,
      errorMessage: err?.message,
      stack: err?.stack
    }, "❌ Google Drive download exception");
    throw err;
  }
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
  logger.info({
    itemId: item.id,
    title: item.title,
    adminChatId,
    hasGoogleDriveUrl: !!item.googleDriveUrl
  }, "🔄 Starting recovery for audio item");
  
  if (!item.googleDriveUrl) {
    logger.error({ itemId: item.id }, "❌ No Google Drive URL available for recovery");
    return false;
  }
  
  try {
    // Download from Google Drive
    logger.info({ itemId: item.id, url: item.googleDriveUrl }, "Step 1: Downloading from Google Drive");
    const audioBuffer = await downloadFromGoogleDrive(item.googleDriveUrl);
    
    logger.info({
      itemId: item.id,
      bufferSize: audioBuffer.length,
      bufferSizeMB: Math.round((audioBuffer.length / (1024 * 1024)) * 100) / 100
    }, "Step 2: Download complete, preparing upload");
    
    // Check size limit
    if (audioBuffer.length > TELEGRAM_AUDIO_LIMIT_BYTES) {
      logger.error({
        itemId: item.id,
        sizeBytes: audioBuffer.length,
        sizeMB: Math.round((audioBuffer.length / (1024 * 1024)) * 100) / 100,
        limitMB: Math.round((TELEGRAM_AUDIO_LIMIT_BYTES / (1024 * 1024)) * 100) / 100
      }, "❌ Audio file too large for Telegram");
      return false;
    }
    
    // Upload to Telegram
    logger.info({
      itemId: item.id,
      title: item.title,
      adminChatId,
      sizeBytes: audioBuffer.length
    }, "Step 3: Uploading to Telegram");
    
    const { Readable } = await import("stream");
    const stream = Readable.from(audioBuffer);
    
    logger.debug({ itemId: item.id }, "Created readable stream, sending to Telegram");
    const uploadStartTime = Date.now();
    
    const message = await bot.telegram.sendAudio(
      adminChatId,
      { source: stream },
      { title: item.title }
    );
    
    const uploadTime = Date.now() - uploadStartTime;
    logger.info({
      itemId: item.id,
      messageId: message.message_id,
      uploadTimeMs: uploadTime
    }, "Step 4: Upload to Telegram complete");
    
    const newFileId = message.audio?.file_id;
    logger.debug({
      itemId: item.id,
      hasAudio: !!message.audio,
      newFileId: newFileId || "MISSING",
      audioObject: message.audio ? Object.keys(message.audio) : "NONE"
    }, "Extracted file ID from Telegram response");
    
    if (!newFileId) {
      logger.error({
        itemId: item.id,
        messageKeys: Object.keys(message),
        hasAudio: !!message.audio,
        audioKeys: message.audio ? Object.keys(message.audio) : []
      }, "❌ Upload succeeded but no file_id returned");
      return false;
    }
    
    // Cache the new file ID
    logger.info({ itemId: item.id, newFileId }, "Step 5: Caching new file ID in database");
    upsertTelegramAudioFileId(db, item.id, newFileId);
    
    logger.info({
      itemId: item.id,
      title: item.title,
      newFileId,
      totalTimeMs: Date.now() - uploadStartTime
    }, "✅ Audio recovered and cached successfully");
    
    return true;
  } catch (err: any) {
    logger.error({
      err,
      itemId: item.id,
      errorMessage: err?.message,
      errorCode: err?.response?.error_code,
      errorDescription: err?.response?.description,
      stack: err?.stack
    }, "❌ Audio recovery failed with exception");
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
    logger.info({
      itemId: item.id,
      title: item.title,
      hasGoogleDriveUrl: !!item.googleDriveUrl,
      googleDriveUrl: item.googleDriveUrl || "NOT SET"
    }, `📋 Processing audio item: ${item.id}`);
    
    const cachedFileId = getTelegramAudioFileId(db, item.id);
    const manifestFileId = item.telegramFileId;
    const fileIdToTest = cachedFileId ?? manifestFileId;
    
    logger.debug({
      itemId: item.id,
      cachedFileId: cachedFileId || "NONE",
      manifestFileId: manifestFileId || "NONE",
      fileIdToTest: fileIdToTest || "NONE"
    }, "File ID lookup results");
    
    // Case 1: No file ID at all - recover from Google Drive if available
    if (!fileIdToTest) {
      logger.info({ itemId: item.id, title: item.title }, "⚠️ No file ID found for item");
      
      if (item.googleDriveUrl) {
        logger.info({ 
          itemId: item.id, 
          title: item.title,
          googleDriveUrl: item.googleDriveUrl 
        }, "✅ Google Drive URL available - starting recovery");
        
        try {
          const success = await recoverAudioItem(bot, db, item, adminChatId);
          if (success) {
            recovered++;
            logger.info({ itemId: item.id }, "✅ Recovery successful");
          } else {
            failed++;
            logger.error({ itemId: item.id }, "❌ Recovery failed");
          }
        } catch (err: any) {
          failed++;
          logger.error({ err, itemId: item.id, stack: err?.stack }, "❌ Recovery threw exception");
        }
        
        // Small delay to avoid rate limits
        logger.debug({ itemId: item.id }, "Waiting 2 seconds before next item");
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        skipped++;
        logger.warn({ itemId: item.id }, "❌ No file ID and no Google Drive URL - cannot recover");
      }
      continue;
    }
    
    // Case 2: File ID exists - validate it
    validated++;
    logger.info({ itemId: item.id, fileId: fileIdToTest }, "🔍 File ID exists - validating");
    
    try {
      const isValid = await testTelegramFileId(bot, fileIdToTest);
      logger.info({ itemId: item.id, fileId: fileIdToTest, isValid }, "File ID validation result");
      
      if (!isValid) {
        logger.warn({ itemId: item.id, fileId: fileIdToTest }, "❌ File ID invalid, attempting recovery from Google Drive");
        
        if (item.googleDriveUrl) {
          logger.info({ 
            itemId: item.id,
            googleDriveUrl: item.googleDriveUrl 
          }, "✅ Google Drive URL available - starting recovery");
          
          try {
            const success = await recoverAudioItem(bot, db, item, adminChatId);
            if (success) {
              recovered++;
              logger.info({ itemId: item.id }, "✅ Recovery successful");
            } else {
              failed++;
              logger.error({ itemId: item.id }, "❌ Recovery returned false");
            }
          } catch (err: any) {
            failed++;
            logger.error({ err, itemId: item.id, stack: err?.stack }, "❌ Recovery threw exception");
          }
        } else {
          failed++;
          logger.warn({ itemId: item.id }, "❌ File ID invalid but no Google Drive URL available for recovery");
        }
        
        // Small delay to avoid rate limits
        logger.debug({ itemId: item.id }, "Waiting 2 seconds before next item");
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        logger.info({ itemId: item.id }, "✅ File ID valid - no recovery needed");
      }
    } catch (err: any) {
      logger.error({ err, itemId: item.id, stack: err?.stack }, "❌ Error during file ID validation");
      failed++;
    }
  }
  
  logger.info({
    total: audioItems.length,
    validated,
    recovered,
    failed,
    skipped,
    summary: {
      totalItems: audioItems.length,
      itemsWithFileIds: validated,
      itemsRecovered: recovered,
      itemsFailed: failed,
      itemsSkipped: skipped
    }
  }, "✅ Audio validation and recovery complete - final summary");
  
  // Notify admins of recovery results
  if (recovered > 0 || failed > 0 || skipped > 0) {
    const message = [
      "🔄 **Audio Recovery Report**",
      "",
      `📊 Total items: ${audioItems.length}`,
      `✅ Validated: ${validated}`,
      `🔄 Recovered: ${recovered}`,
      `❌ Failed: ${failed}`,
      `⏭️ Skipped: ${skipped}`
    ].join("\n");
    
    logger.info({ message, adminCount: adminChatIds.length }, "Sending recovery report to admins");
    
    for (const adminId of adminChatIds) {
      try {
        await bot.telegram.sendMessage(adminId, message);
        logger.debug({ adminId }, "Recovery report sent to admin");
      } catch (err) {
        logger.error({ err, adminId, errorMessage: err instanceof Error ? err.message : String(err) }, "❌ Failed to notify admin of recovery results");
      }
    }
  } else {
    logger.info("All audio files valid - no recovery needed, no admin notification sent");
  }
}
