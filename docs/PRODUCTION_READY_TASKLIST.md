# Telegram Bot Production Readiness Task List

This task list is tailored to this codebase and your updated deployment plan:

- Bot hosted on a dedicated server
- Audio/uploads served from dedicated virtual storage (object storage or mounted persistent storage)
- GHL webhooks used for billing state
- Telegram bot used for gated content delivery

## Target outcome (definition of done)

- Webhooks are authenticated with HMAC signatures only
- Bot and webhook server run reliably on a hardened dedicated server
- Audio files are delivered from durable storage (no runtime dependency on Google Drive)
- SQLite data is on persistent disk with backup + restore verification (or migrated to Postgres)
- Monitoring, alerts, logs, and restart policies are in place
- A tested rollback process exists
- Staging smoke test and production cutover checklist are completed

## Phase 1: Architecture and hosting decisions

- [ ] Choose storage model:
- [ ] `Option A`: Object storage (S3/R2/B2/Spaces) + bot sends files by URL/stream + Telegram `file_id` cache
- [ ] `Option B`: Mounted persistent volume on server + local file send + Telegram `file_id` cache
- [ ] Decide whether to keep SQLite (single-node only) or move to Postgres before launch
- [ ] Decide reverse proxy (`Caddy` or `Nginx`) for TLS termination + IP filtering + rate limiting
- [ ] Create separate environments: `staging` and `production`
- [ ] Define production domain(s), e.g. `bot.example.com`
- [ ] Define ownership for operations (who rotates keys, who responds to alerts, who deploys)

## Phase 2: Server provisioning and OS hardening (dedicated server)

- [ ] Provision the dedicated server with supported OS (Ubuntu LTS recommended)
- [ ] Create a non-root deploy user
- [ ] Disable password SSH auth and use SSH keys only
- [ ] Enable automatic security updates (or scheduled patching)
- [ ] Configure firewall (`ufw`/cloud firewall):
- [ ] Allow `22/tcp` (restricted to your IPs if possible)
- [ ] Allow `80/tcp` and `443/tcp`
- [ ] Block all other inbound ports
- [ ] Install Node.js LTS (match version used in staging)
- [ ] Install process supervisor (`systemd` service)
- [ ] Install reverse proxy (`Caddy` or `Nginx`)
- [ ] Enable time sync (NTP) and verify timezone/log timestamps
- [ ] Configure disk monitoring (free space alerts)
- [ ] Configure log rotation for app and proxy logs

## Phase 3: Virtual storage setup (audio/uploads)

- [ ] Create production storage bucket/volume
- [ ] Create staging storage bucket/volume
- [ ] Define folder/key structure (e.g. `audio/<category>/<filename>.mp3`)
- [ ] Configure least-privilege credentials:
- [ ] Read-only key for bot runtime
- [ ] Write key only for admin upload tooling (if needed)
- [ ] Enable server-side encryption at rest
- [ ] Configure lifecycle/versioning policy (at least versioning for accidental overwrite recovery)
- [ ] Set access policy:
- [ ] Private objects + signed URLs (preferred), or
- [ ] Public-read objects if content is intentionally public
- [ ] Upload all production audio files to storage
- [ ] Generate checksum manifest (SHA-256) for uploaded files
- [ ] Verify file sizes stay below Telegram bot upload limits where applicable
- [ ] Document recovery process if a file is deleted/corrupted

## Phase 4: Content migration and catalog readiness

- [ ] Replace Google Drive dependency for production audio items in `audio/manifest.json`
- [ ] Ensure every audio item has at least one durable source:
- [ ] `telegramFileId` (preferred for delivery performance), or
- [ ] valid storage URL / resolvable storage path
- [ ] Fix missing local file references currently present in manifest (`meditation-15min`, `meditation-20min`)
- [ ] Validate `audio/manifest.json` against production storage paths
- [ ] Run a full content integrity check script before each deployment
- [ ] Pre-cache Telegram `file_id`s for all production audio items (recommended)
- [ ] Export and persist `telegramFileId` values into `audio/manifest.json` for disaster recovery

## Phase 5: Application code hardening (required changes in this repo)

- [ ] Remove or disable automatic startup bulk audio re-upload from Google Drive in `src/index.ts`
- [ ] Replace Google Drive recovery flow in `src/content/audioRecovery.ts` with storage-backed recovery
- [ ] Add config flags for storage provider, bucket/path, and startup recovery behavior
- [ ] Stop logging full checkout URLs in `src/bot/flows/subscribe.ts` (PII/log leakage)
- [ ] Add centralized HTTP client wrapper with:
- [ ] request timeouts (`AbortController`)
- [ ] retry with exponential backoff + jitter
- [ ] bounded max retries
- [ ] consistent error classification/logging
- [ ] Use the HTTP wrapper for all GHL calls in `src/ghl/ghlClient.ts`
- [ ] Use the HTTP wrapper for `src/ghl/contactLookup.ts`
- [ ] Use the HTTP wrapper for storage/recovery downloads
- [ ] Add config validation for production-only requirements (fail fast if missing)
- [ ] Add log redaction (tokens, keys, URLs, customData PII) in `src/logger.ts` / webhook logs
- [ ] Add payload size limit for webhook raw body parser (`express.raw`)
- [ ] Add guardrails so `ENABLE_PAYMENTS=false` cannot be used accidentally in production

## Phase 6: Webhook security and network controls (must do before production)

- [ ] Configure GHL webhook signing and set `GHL_WEBHOOK_SECRET`
- [ ] Rotate current `WEBHOOK_TOKEN` and stop using token auth in production
- [ ] Enforce HMAC-only auth path in production code/config
- [ ] Restrict `trust proxy` setting in `src/index.ts` to expected hop count (not blanket `true`)
- [ ] Replace in-memory IP rate limiter with:
- [ ] reverse-proxy rate limiting (minimum), and/or
- [ ] Redis/shared limiter if you plan multi-instance later
- [ ] Add reverse proxy request size limits and timeouts
- [ ] Add allowlist/IP filtering for webhook path if GHL IP ranges are known/usable
- [ ] Validate TLS configuration (modern ciphers, auto-renew certs)
- [ ] Add webhook replay test (old timestamp + same signature should fail)

## Phase 7: Database hardening and persistence

- [ ] Put `DB_PATH` on persistent disk/volume (not ephemeral path)
- [ ] Create scheduled SQLite backups (at least daily, ideally more frequent)
- [ ] Copy backups off-server (object storage)
- [ ] Test restore from backup into a clean environment
- [ ] Define retention policy for:
- [ ] `webhook_events`
- [ ] expired `checkout_tokens`
- [ ] old logs
- [ ] Add DB indexes for expected growth paths (`webhook_events.received_at`, `webhook_events.telegram_user_id`, etc.)
- [ ] Add a real migration system (tracked SQL migrations instead of ad hoc `ALTER TABLE`)
- [ ] Add a startup DB integrity check and schema version check
- [ ] Decide when to migrate to Postgres (trigger threshold: users/events size or HA need)

## Phase 8: State management, concurrency, and reliability

- [ ] Add TTL cleanup for in-memory `pendingIngest` sessions in `src/bot/bot.ts`
- [ ] Add failure-safe behavior for long-running admin ingest/recovery commands
- [ ] Add concurrency limits for audio recovery/upload jobs
- [ ] Ensure large file operations do not load entire files into memory when avoidable
- [ ] Add timeout and cancellation handling for Telegram send operations where possible
- [ ] Review and fix UX logic edge cases (e.g. duplicate cancel prompts in `cancelRetention` flow)
- [ ] Add graceful shutdown sequencing:
- [ ] stop receiving new webhooks
- [ ] stop bot polling
- [ ] drain in-flight tasks
- [ ] close DB cleanly

## Phase 9: Observability, logging, and alerting

- [ ] Standardize structured logs (JSON) in production
- [ ] Add log redaction for secrets and PII
- [ ] Configure centralized log shipping (e.g. Loki/ELK/Datadog/Cloud logging)
- [ ] Add metrics for:
- [ ] webhook requests (count, latency, auth failures, duplicates)
- [ ] Telegram send success/failure rate
- [ ] GHL API latency/error rate
- [ ] audio delivery latency and fallback frequency
- [ ] DB size and backup success
- [ ] server CPU/memory/disk/network
- [ ] Add alerts for:
- [ ] process down / health check failing
- [ ] webhook auth failures spike
- [ ] Telegram API failures spike
- [ ] disk low space
- [ ] backup failure
- [ ] high error rate / uncaught exceptions
- [ ] Create an on-call runbook (where to look, how to restart, how to rollback)

## Phase 10: Deployment automation and rollback

- [ ] Create a repeatable build/deploy script (or CI pipeline)
- [ ] Add CI checks:
- [ ] `npm ci`
- [ ] `npm run build`
- [ ] tests (after added)
- [ ] `npm audit --omit=dev`
- [ ] manifest validation script
- [ ] Package release artifacts (compiled `dist/`, config templates, systemd unit, proxy config)
- [ ] Create systemd service file for bot app
- [ ] Create reverse proxy config for `/healthz` and `/webhooks/ghl`
- [ ] Add deployment steps for zero/low downtime restart (blue/green or quick restart with health checks)
- [ ] Create rollback procedure:
- [ ] previous build artifact restore
- [ ] config rollback
- [ ] DB restore decision tree (when to restore vs not restore)
- [ ] Test rollback in staging

## Phase 11: Testing and verification (staging before prod)

- [ ] Create automated tests for:
- [ ] webhook signature verification
- [ ] webhook normalization + state transitions
- [ ] idempotency handling
- [ ] out-of-order event suppression
- [ ] access control for browse/audio routes
- [ ] Add integration tests for `/webhooks/ghl`
- [ ] Add staging `.env` with non-production secrets
- [ ] Run end-to-end staging test:
- [ ] `/start`
- [ ] `/subscribe`
- [ ] webhook `subscription.created`
- [ ] webhook `subscription.updated` (cancel pending)
- [ ] webhook `subscription.cancelled`
- [ ] webhook `payment.failed`
- [ ] `/resync`
- [ ] audio browse and delivery for all items
- [ ] Test invalid/expired signature webhook (must reject)
- [ ] Test duplicate webhook delivery (must be ignored)
- [ ] Test out-of-order webhook delivery (must suppress older event)
- [ ] Test bot restart and confirm state persistence + audio delivery continuity
- [ ] Run a basic load test on webhook endpoint (rate limiting + latency behavior)

## Phase 12: Secrets, access control, and compliance basics

- [ ] Move production secrets out of `.env` files on disk where possible (use secret manager or root-owned env file with strict perms)
- [ ] Set strict file permissions for runtime env/config files
- [ ] Rotate bot token, GHL API key, and webhook secret before go-live
- [ ] Create a key rotation schedule and owner
- [ ] Document what user data is stored (`telegram_user_id`, subscription state, webhook metadata)
- [ ] Define retention policy and deletion process for user records/logs
- [ ] Add admin action logging for privileged commands (`/admin_*`)
- [ ] Create privacy policy / terms text if applicable to your audience/jurisdiction

## Phase 13: Go-live checklist (production cutover)

- [ ] Production domain resolves correctly
- [ ] TLS certificate active and auto-renewing
- [ ] Reverse proxy routes `/healthz` and `/webhooks/ghl` correctly
- [ ] App service starts on boot and auto-restarts on failure
- [ ] `ENABLE_PAYMENTS=true` confirmed in production
- [ ] `GHL_WEBHOOK_SECRET` present and verified
- [ ] `WEBHOOK_TOKEN` disabled/unused in production
- [ ] Persistent DB path configured and writable
- [ ] Storage credentials verified (read access)
- [ ] Audio catalog verified end-to-end in production
- [ ] Health endpoint returns `200`
- [ ] Logs visible in central logging
- [ ] Alerts tested (at least one synthetic test)
- [ ] Backup job ran successfully
- [ ] Restore test previously completed and documented
- [ ] GHL webhook endpoint updated to production URL
- [ ] Final smoke test completed with test account

## Phase 14: Post-launch operations (first 2 weeks)

- [ ] Monitor webhook auth failures and duplicates daily
- [ ] Review Telegram API send failures daily
- [ ] Review storage bandwidth and egress costs daily
- [ ] Confirm backup success and retention jobs
- [ ] Review logs for PII leakage and tighten redaction if needed
- [ ] Patch any high-severity dependency updates
- [ ] Schedule first security review and dependency update cadence

## Suggested implementation order (fastest path to safe launch)

- [ ] 1) Webhook security hardening (HMAC-only, proxy trust, rate limits)
- [ ] 2) Storage migration (remove Google Drive dependency in prod path)
- [ ] 3) Disable startup bulk re-upload + add resilient HTTP client
- [ ] 4) Persistent DB backups + restore test
- [ ] 5) Observability + alerts + systemd/proxy deploy setup
- [ ] 6) Staging E2E validation and production cutover

## Notes for this codebase specifically

- Current code has a startup path that schedules audio recovery/upload work in `src/index.ts`; this should not run automatically in production.
- Current code supports good webhook idempotency and ordering suppression; keep those safeguards while refactoring.
- You can still use Telegram `file_id` caching even with dedicated storage, which reduces repeated bandwidth and improves delivery reliability.

