import fs from "node:fs";
import path from "node:path";

export function resolveAudioFilePath(filePath: string): string {
  // The manifest stores file paths relative to audio/files/.
  const fullPath = path.join(process.cwd(), "audio", "files", filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Audio file not found: ${fullPath}`);
  }
  return fullPath;
}

