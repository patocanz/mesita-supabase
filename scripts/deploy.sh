#!/usr/bin/env bash
#
# One-shot deploy for the venue critical path.
# After this completes successfully, the end-to-end flow works in prod:
#   manager signs up → creates a venue → guest signs up → sees the venue.
#
# Run from the mesita-supabase repo root:
#   ./scripts/deploy.sh
#
# Idempotent: safe to re-run.

set -euo pipefail

PROJECT_REF="yjalywfzdelacdzccpgb"
WEB_REPO="../mesita-web-platform"
TYPES_TARGET="$WEB_REPO/src/lib/supabase/database.types.ts"

cd "$(dirname "$0")/.."

echo "▶ Linking to project $PROJECT_REF…"
supabase link --project-ref "$PROJECT_REF"

echo "▶ Applying migrations to remote (0001_init.sql)…"
supabase db push

echo "▶ Deploying Edge Functions…"
supabase functions deploy venues-list
supabase functions deploy venues-create
supabase functions deploy venues-mine

if [ -d "$WEB_REPO" ]; then
  echo "▶ Regenerating TypeScript types…"
  supabase gen types typescript --linked > "$TYPES_TARGET"
  echo "  → wrote $TYPES_TARGET"
else
  echo "⚠ Skipping type regeneration ($WEB_REPO not found)"
fi

echo ""
echo "✓ Deploy complete."
echo ""
echo "Smoke test (after starting the web dev server with: pnpm dev):"
echo "  1. Visit /manager/sign-up → create account → land on /manager (empty)"
echo "  2. Click 'Create your first venue' → fill name → submit"
echo "  3. Sign out, sign up at /guest/sign-up → land on /guest/discover/swipe"
echo "  4. The venue you created should be in the deck"
