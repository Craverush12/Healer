#!/bin/bash
# Syncs audio manifest and files from S3 to local audio/ directory.
# Used at instance startup before starting the bot (see docs/AWS_LIGHTSAIL_S3_DEPLOYMENT.md).
#
# Required: AWS CLI configured (credentials + region). Set S3_AUDIO_BUCKET or edit below.
# Usage: ./scripts/sync-audio-from-s3.sh

set -e

# Bucket name (override with env: S3_AUDIO_BUCKET)
BUCKET="${S3_AUDIO_BUCKET:-healer-bot-audio-prod}"

# App root: directory containing package.json (default: script's parent's parent)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="${APP_ROOT:-$(dirname "$SCRIPT_DIR")}"
cd "$APP_ROOT"

mkdir -p audio
mkdir -p audio/files

# Sync manifest to audio/manifest.json
aws s3 cp "s3://${BUCKET}/manifest.json" "./audio/manifest.json"

# Sync audio files to audio/files/
aws s3 sync "s3://${BUCKET}/files/" "./audio/files/" --delete

echo "S3 sync completed at $(date -Iseconds) (bucket=${BUCKET})"
