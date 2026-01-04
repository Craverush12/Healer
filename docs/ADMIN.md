# Admin Guide (Audio Library)

Admins manage audio content without touching code.

## Where files live

- MP3 files: `audio/files/`
- Manifest: `audio/manifest.json`
- Cached Telegram `file_id`s (production): SQLite table `telegram_audio_cache` (in `DB_PATH`)

## Production recommendation (inline playback)

To make audio play inline in Telegram without streaming from your server, cache Telegram `file_id`s once and reuse them:

1) Set `ADMIN_TELEGRAM_USER_IDS` in `.env` to your Telegram numeric user id (or a comma-separated list).
2) Run the bot and send:
   - `/admin_missing_file_ids` to list items without cached ids
   - `/admin_ingest <itemId>` to upload an item once and cache its `file_id`

After ingest, the bot will prefer sending by `file_id` (fast + reliable) and fall back to disk streaming if missing.

### No persistent storage? Bake `file_id`s into the manifest

If your host does not give you a persistent disk (e.g., Render free tier), you can stay free by storing the `file_id` in `audio/manifest.json`:

1) Run locally with the MP3 files present.
2) In Telegram, run `/admin_ingest <itemId>`; the bot replies with the `telegramFileId` snippet.
3) Add `"telegramFileId": "<value>"` to that item in `audio/manifest.json`.
4) Commit and deploy; production will use the manifest value without needing a DB cache or local files.

`/admin_missing_file_ids` now considers both the DB cache and `telegramFileId` in the manifest.

## Add audio

1. Copy an MP3 into `audio/files/` (example: `sleep-meditation-01.mp3`)
2. Edit `audio/manifest.json`:
   - Add a category if needed
   - Add an item pointing to the file

Example item:

```json
{
  "id": "sleep-01",
  "title": "Sleep Meditation 01",
  "categoryId": "sleep",
  "filePath": "sleep-meditation-01.mp3",
  "description": "A short guided meditation to fall asleep."
}
```

Restart the bot process so it reloads the manifest.

## Delete audio

1. Remove the item from `audio/manifest.json`
2. Delete the MP3 from `audio/files/`
3. Restart the bot process

## Rules / gotchas

- `id` must be unique across all categories/items.
- `filePath` is relative to `audio/files/`.
- If a referenced MP3 file is missing, the bot will error when sending that audio.
- Very large files may exceed Telegram limits; split or re-encode long tracks (e.g., the ~600MB file) into smaller parts.

