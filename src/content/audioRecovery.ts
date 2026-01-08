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
 * Uploads to the specified chat ID (can be any user, not just admin).
 * Returns the new file_id if successful, null otherwise.
 */
export async function recoverAudioItemForUser(
  bot: Telegraf,
  db: SqliteDb,
  item: { id: string; title: string; googleDriveUrl?: string },
  chatId: number,
  caption?: string
): Promise<string | null> {
  const success = await recoverAudioItem(bot, db, item, chatId, caption);
  if (success) {
    // Return the newly cached file_id
    return getTelegramAudioFileId(db, item.id) ?? null;
  }
  return null;
}

/**
 * Internal function to recover a single audio item from Google Drive.
 * Uploads to the specified chat ID (can be any user, not just admin).
 */
async function recoverAudioItem(
  bot: Telegraf,
  db: SqliteDb,
  item: { id: string; title: string; googleDriveUrl?: string },
  chatId: number,
  caption?: string
): Promise<boolean> {
  logger.info({
    itemId: item.id,
    title: item.title,
    chatId,
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
      chatId,
      sizeBytes: audioBuffer.length
    }, "Step 3: Uploading to Telegram");
    
    const { Readable } = await import("stream");
    const stream = Readable.from(audioBuffer);
    
    logger.debug({ itemId: item.id }, "Created readable stream, sending to Telegram");
    const uploadStartTime = Date.now();
    
    const message = await bot.telegram.sendAudio(
      chatId,
      { source: stream },
      { title: item.title, caption }
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
 * Always re-uploads all audio items from Google Drive on startup.
 * This ensures fresh file_ids after each deployment.
 * Simpler approach: always upload from Google Drive if URL is available.
 */
export async function uploadAllAudioFromGoogleDrive(
  bot: Telegraf,
  db: SqliteDb,
  audio: AudioLibrary,
  chatId: number
): Promise<{ uploaded: number; failed: number; total: number }> {
  logger.info("=".repeat(60));
  logger.info("🔄 uploadAllAudioFromGoogleDrive FUNCTION CALLED");
  logger.info("=".repeat(60));
  logger.info({
    chatId,
    audioItemsCount: audio.manifest.items.length,
    hasBot: !!bot,
    hasDb: !!db,
    hasAudio: !!audio
  }, "Function parameters check");
  
  const audioItems = audio.manifest.items.filter(item => !item.type || item.type === "audio");
  const itemsWithGoogleDrive = audioItems.filter(item => item.googleDriveUrl);
  
  logger.info({
    totalAudioItems: audioItems.length,
    itemsWithGoogleDrive: itemsWithGoogleDrive.length,
    itemsWithoutGoogleDrive: audioItems.length - itemsWithGoogleDrive.length
  }, "📋 Audio items analysis");
  
  if (itemsWithGoogleDrive.length === 0) {
    logger.warn("No audio items have Google Drive URLs - skipping upload");
    return { uploaded: 0, failed: 0, total: 0 };
  }
  
  let uploaded = 0;
  let failed = 0;
  
  for (const item of itemsWithGoogleDrive) {
    logger.info({
      itemId: item.id,
      title: item.title,
      googleDriveUrl: item.googleDriveUrl
    }, `📤 Uploading audio item: ${item.id} - ${item.title}`);
    
    try {
      const success = await recoverAudioItem(bot, db, item, chatId, undefined);
      if (success) {
        uploaded++;
        logger.info({ itemId: item.id, title: item.title }, "✅ Upload successful");
      } else {
        failed++;
        logger.error({ itemId: item.id, title: item.title }, "❌ Upload failed");
      }
    } catch (err: any) {
      failed++;
      logger.error({ 
        err, 
        itemId: item.id, 
        title: item.title,
        errorMessage: err?.message,
        stack: err?.stack 
      }, "❌ Upload threw exception");
    }
    
    // Small delay to avoid rate limits
    logger.debug({ itemId: item.id }, "Waiting 2 seconds before next item");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  logger.info({
    total: itemsWithGoogleDrive.length,
    uploaded,
    failed,
    summary: {
      totalItems: itemsWithGoogleDrive.length,
      itemsUploaded: uploaded,
      itemsFailed: failed
    }
  }, "✅ Audio upload from Google Drive complete - final summary");
  
  return { uploaded, failed, total: itemsWithGoogleDrive.length };
}

/**
 * Validates and recovers all audio items on startup.
 * Runs in background after bot initialization.
 * If no admin chat IDs provided, recovery will happen on-demand when users request audio.
 */
export async function validateAndRecoverAudio(
  bot: Telegraf,
  db: SqliteDb,
  audio: AudioLibrary,
  adminChatIds: number[] = []
): Promise<void> {
  logger.info({
    adminChatIdsCount: adminChatIds.length,
    adminChatIds: adminChatIds,
    audioItemsCount: audio.manifest.items.length
  }, "🔄 validateAndRecoverAudio called - entry point");
  
  // If no admin IDs, skip startup recovery - it will happen on-demand when users request audio
  if (adminChatIds.length === 0) {
    logger.info("No admin chat IDs provided - audio recovery will happen on-demand when users request audio");
    return;
  }
  
  const chatId = adminChatIds[0]; // Use first admin for uploads
  logger.info({ chatId, totalAdmins: adminChatIds.length }, "Using admin chat ID for uploads");
  
  // Always re-upload from Google Drive on startup (simpler and more reliable)
  const result = await uploadAllAudioFromGoogleDrive(bot, db, audio, chatId);
  
  // Notify admins of upload results
  if (result.total > 0) {
    const message = [
      "🔄 **Startup Audio Upload Complete**",
      "",
      `📊 Total items with Google Drive: ${result.total}`,
      `✅ Successfully uploaded: ${result.uploaded}`,
      result.failed > 0 ? `❌ Failed: ${result.failed}` : "",
      "",
      "All successfully uploaded audio files are now ready to use."
    ].filter(Boolean).join("\n");
    
    logger.info({ message, adminCount: adminChatIds.length, result }, "Sending upload report to admins");
    
    for (const adminId of adminChatIds) {
      try {
        await bot.telegram.sendMessage(adminId, message);
        logger.debug({ adminId }, "Upload report sent to admin");
      } catch (err) {
        logger.error({ err, adminId, errorMessage: err instanceof Error ? err.message : String(err) }, "❌ Failed to notify admin of upload results");
      }
    }
  }
}
