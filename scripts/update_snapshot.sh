#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/../stellas_branch"
DST="$ROOT/vendor/stellas_snapshot"

mkdir -p "$DST"

# If snapshot was made read-only before, temporarily unlock it
chmod -R u+w "$DST" 2>/dev/null || true

# Copy entire repo minus heavy stuff
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'build' \
  --exclude '.next' \
  --exclude '.cache' \
  --exclude 'coverage' \
  --exclude '*.log' \
  "$SRC/" \
  "$DST/"

# Lock snapshot (optional but recommended)
chmod -R a-w "$DST" 2>/dev/null || true

echo "Snapshot updated: $DST"
