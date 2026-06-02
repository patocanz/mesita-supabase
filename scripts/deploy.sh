#!/usr/bin/env bash
#
# Apply pending migrations to the linked Supabase project and
# regenerate TypeScript types for every web repo that consumes them.
#
# Run from the mesita-supabase repo root:
#   ./scripts/deploy.sh
#
# Edge Functions are deployed individually (or via `supabase functions
# deploy <name>`) when their code actually changes — we don't redeploy
# all 52 on every push. The deploy step lives in CI / per-EF commits.

set -euo pipefail

PROJECT_REF="yjalywfzdelacdzccpgb"

# Web repos sitting next to this one that import database.types.ts.
# Add new consumer repos here as they appear.
WEB_REPOS=(
  "../mesita-web-business"
  "../mesita-web-consumer"
  "../mesita-web-admin"
)

cd "$(dirname "$0")/.."

# Supabase CLI reads project-root .env for config.toml env(TWILIO_*).
bash scripts/sync-root-env.sh

echo "▶ Linking to project ${PROJECT_REF} ..."
supabase link --project-ref "${PROJECT_REF}"

if [[ "${SKIP_DB_PUSH:-}" == "1" ]]; then
  echo "▶ Skipping db push (SKIP_DB_PUSH=1)"
else
echo "▶ Pushing pending migrations ..."
if ! supabase db push --include-all; then
  echo ""
  echo "⚠ db push failed (migration history drift)."
  echo "  If production schema is already correct, run once:"
  echo "    ./scripts/sync-migration-history.sh"
  echo "  Then re-run ./scripts/deploy.sh"
  echo "  Or skip push and only regen types: SKIP_DB_PUSH=1 ./scripts/deploy.sh"
  exit 1
fi
fi

for repo in "${WEB_REPOS[@]}"; do
  target="$repo/src/lib/supabase/database.types.ts"
  if [ -d "$repo" ] && [ -f "$target" ]; then
    echo "▶ Regenerating $target"
    supabase gen types typescript --linked > "$target" 2>/dev/null
  else
    echo "⚠ Skipping $repo (path or types file not found)"
  fi
done

echo ""
echo "OK Deploy complete."
