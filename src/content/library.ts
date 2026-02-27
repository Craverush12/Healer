import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const CategorySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  usageInstructions: z.string().optional(),
  type: z.enum(["audio", "text"]).default("audio"),
  content: z.string().optional(), // For text-based categories (Welcome/Setup)
  recommended: z.boolean().optional()
});

const ItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  categoryId: z.string().min(1),
  filePath: z.string().optional(), // Optional for external links
  url: z.string().url().optional(), // For external links (Spotify, etc.)
  telegramFileId: z.string().optional(), // Optional: cached Telegram file_id, lets us avoid local files in production
  remoteUrl: z.string().url().optional(), // Provider-agnostic remote backup/storage URL for recovery
  googleDriveUrl: z.string().url().optional(), // Legacy Google Drive backup URL (backward compatibility)
  description: z.string().optional(),
  duration: z.string().optional(), // e.g., "15 min", "8 hours"
  recommended: z.boolean().optional(), // "Start Here" flag
  whenToUse: z.array(z.string()).optional(), // e.g., ["morning", "evening", "sleep"]
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  type: z.enum(["audio", "external"]).default("audio")
});

const ManifestSchema = z.object({
  categories: z.array(CategorySchema),
  items: z.array(ItemSchema)
});

export type AudioCategory = z.infer<typeof CategorySchema>;
export type AudioItem = z.infer<typeof ItemSchema>;
export type AudioManifest = z.infer<typeof ManifestSchema>;

type AudioItemWithRemoteBackup = {
  remoteUrl?: string;
  googleDriveUrl?: string;
};

export type AudioLibrary = {
  manifest: AudioManifest;
  categoriesById: Map<string, AudioCategory>;
  itemsById: Map<string, AudioItem>;
  itemsByCategoryId: Map<string, AudioItem[]>;
};

export function getAudioRemoteBackupUrl(item: AudioItemWithRemoteBackup): string | null {
  const remoteUrl = typeof item.remoteUrl === "string" && item.remoteUrl.trim().length > 0 ? item.remoteUrl.trim() : null;
  if (remoteUrl) return remoteUrl;
  const legacyGoogleDriveUrl =
    typeof item.googleDriveUrl === "string" && item.googleDriveUrl.trim().length > 0 ? item.googleDriveUrl.trim() : null;
  return legacyGoogleDriveUrl;
}

export function getAudioRemoteBackupSource(item: AudioItemWithRemoteBackup): "remoteUrl" | "googleDriveUrl" | null {
  if (typeof item.remoteUrl === "string" && item.remoteUrl.trim().length > 0) return "remoteUrl";
  if (typeof item.googleDriveUrl === "string" && item.googleDriveUrl.trim().length > 0) return "googleDriveUrl";
  return null;
}

export function loadAudioLibrary(manifestPath = path.join(process.cwd(), "audio", "manifest.json")): AudioLibrary {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const json = JSON.parse(raw) as unknown;
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid audio manifest at ${manifestPath}: ${parsed.error.message}`);
  }

  const manifest = parsed.data;
  const categoriesById = new Map<string, AudioCategory>();
  for (const c of manifest.categories) categoriesById.set(c.id, c);

  const itemsById = new Map<string, AudioItem>();
  const itemsByCategoryId = new Map<string, AudioItem[]>();
  for (const item of manifest.items) {
    itemsById.set(item.id, item);
    const arr = itemsByCategoryId.get(item.categoryId) ?? [];
    arr.push(item);
    itemsByCategoryId.set(item.categoryId, arr);
  }

  // Validation: items must have either filePath or url
  for (const item of manifest.items) {
    if (!categoriesById.has(item.categoryId)) {
      throw new Error(`Invalid audio manifest: item '${item.id}' references missing categoryId '${item.categoryId}'.`);
    }
    if (item.type === "audio" && !item.filePath && !item.telegramFileId && !getAudioRemoteBackupUrl(item)) {
      throw new Error(
        `Invalid audio manifest: item '${item.id}' is type 'audio' but has no filePath, telegramFileId, or remote backup URL.`
      );
    }
    if (item.type === "external" && !item.url) {
      throw new Error(`Invalid audio manifest: item '${item.id}' is type 'external' but has no url.`);
    }
  }

  return { manifest, categoriesById, itemsById, itemsByCategoryId };
}
