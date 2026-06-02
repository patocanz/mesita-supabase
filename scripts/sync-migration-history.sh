#!/usr/bin/env bash
# One-time (or occasional) repair when `supabase db push` fails with:
#   "Remote migration versions not found in local migrations directory"
#
# Production was migrated with timestamp versions applied outside this repo;
# local files use 0001_*, 20260601_*, etc. This script:
#   1. Marks remote-only versions as reverted (CLI stops complaining)
#   2. Marks local-only versions as applied (schema already on remote)
#
# Run from mesita-supabase:
#   ./scripts/sync-migration-history.sh
#
# Safe when remote DB already matches your local migration *content*.
# Do NOT run on a fresh empty database.

set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/sync-root-env.sh

echo "▶ Linking ..."
supabase link --project-ref yjalywfzdelacdzccpgb >/dev/null

echo "▶ Reading migration list ..."
LIST=$(supabase migration list --linked 2>/dev/null || true)
if [[ -z "${LIST}" ]]; then
  echo "Could not read migration list. Run: supabase login && supabase link"
  exit 1
fi

REMOTE_ONLY=$(echo "${LIST}" | awk -F'|' '
  NR > 3 && $1 !~ /[0-9]/ && $2 ~ /[0-9]/ {
    gsub(/ /, "", $2); print $2
  }
')

LOCAL_ONLY=$(echo "${LIST}" | awk -F'|' '
  NR > 3 && $1 ~ /[0-9]/ && $2 !~ /[0-9]/ {
    gsub(/ /, "", $1); print $1
  }
')

revert_count=$(echo "${REMOTE_ONLY}" | grep -c . || true)
apply_count=$(echo "${LOCAL_ONLY}" | grep -c . || true)

echo "   Remote-only (will mark reverted): ${revert_count}"
echo "   Local-only (will mark applied):   ${apply_count}"

if [[ "${revert_count}" -eq 0 && "${apply_count}" -eq 0 ]]; then
  echo "Nothing to repair. History already aligned."
  exit 0
fi

if [[ "${revert_count}" -gt 0 ]]; then
  echo "▶ Repair remote-only → reverted ..."
  # shellcheck disable=SC2086
  supabase migration repair --status reverted ${REMOTE_ONLY}
fi

if [[ "${apply_count}" -gt 0 ]]; then
  echo "▶ Repair local-only → applied ..."
  # shellcheck disable=SC2086
  supabase migration repair --status applied ${LOCAL_ONLY}
fi

# Duplicate numeric prefixes (0021 x2, 0031 x3) were renamed to unique timestamps.
# Mark those as applied if production already has the schema.
EXTRA="20252120001 20260531120001 20260531120002 20260531120003"
if ls supabase/migrations/20252120001_*.sql >/dev/null 2>&1; then
  echo "▶ Mark renamed migrations as applied (no-op if already recorded) ..."
  # shellcheck disable=SC2086
  supabase migration repair --status applied ${EXTRA} 2>/dev/null || true
fi

echo ""
echo "OK Migration history synced. Try: ./scripts/deploy.sh"
