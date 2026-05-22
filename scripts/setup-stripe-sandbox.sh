#!/usr/bin/env bash
#
# One-shot setup for the Mesita Stripe sandbox.
#
# Sets every Edge Function secret the Stripe foundation + Connect
# onboarding code needs, applies migration 0020, deploys the two
# Phase 3a EFs. Idempotent: safe to re-run.
#
# Required env vars (export before running):
#   STRIPE_SECRET_KEY                   sk_test_...
#   STRIPE_WEBHOOK_SECRET_CONNECT       whsec_...   (from `we_1TZyCxDtV9HHKsoygdHzvGRm`)
#
# Optional overrides (defaults are the manager.mesita.ai production URLs):
#   STRIPE_CONNECT_RETURN_URL
#   STRIPE_CONNECT_REFRESH_URL
#
# All other values (Price IDs, fee BPS) are sandbox-stable and baked in
# below. They were created against Stripe sandbox account
# acct_1TZvCNDtV9HHKsoy on 2026-05-22.

set -euo pipefail

PROJECT_REF="yjalywfzdelacdzccpgb"

cd "$(dirname "$0")/.."

# --- guard rails ---------------------------------------------------------

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "✗ $name is not exported. Set it before running this script."
    exit 1
  fi
}

require_env STRIPE_SECRET_KEY
require_env STRIPE_WEBHOOK_SECRET_CONNECT

if ! command -v supabase >/dev/null 2>&1; then
  echo "✗ supabase CLI not found. Install: https://supabase.com/docs/guides/cli"
  exit 1
fi

RETURN_URL="${STRIPE_CONNECT_RETURN_URL:-https://manager.mesita.ai/wallet?connect=done}"
REFRESH_URL="${STRIPE_CONNECT_REFRESH_URL:-https://manager.mesita.ai/wallet?connect=refresh}"

# --- sandbox price + product IDs (test mode) -----------------------------

# Created 2026-05-22 against acct_1TZvCNDtV9HHKsoy. Bake into the script
# because they're public (price_... is not a secret) and stable. For
# production we'll bump these to live-mode IDs in a separate setup script.

STRIPE_PRICE_VENUE_FORMAL_PRO="price_1TZyBgDtV9HHKsoyCPyOqC5g"
STRIPE_PRICE_VENUE_INFORMAL_PRO="price_1TZyBhDtV9HHKsoy8btKzUYF"
STRIPE_PRICE_GUEST_SILVER="price_1TZyBiDtV9HHKsoy9xs1gnQi"
STRIPE_PRICE_GUEST_GOLD="price_1TZyBjDtV9HHKsoyVerUW9Jv"
STRIPE_PRICE_GUEST_DIAMOND="price_1TZyBkDtV9HHKsoyBR0nraX3"

# Mesita platform fee in basis points (5% = 500). Sane default for
# Formal Pro plan; per-venue overrides land later when we model
# negotiated fees.
STRIPE_MESITA_FEE_BPS="500"

# --- link + push migration -----------------------------------------------

echo "▶ Linking to project $PROJECT_REF…"
supabase link --project-ref "$PROJECT_REF" 2>/dev/null || true

echo "▶ Applying migrations (no-op if already current)…"
supabase db push

# --- set EF secrets ------------------------------------------------------

echo "▶ Setting Edge Function secrets…"
supabase secrets set \
  STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
  STRIPE_WEBHOOK_SECRET_CONNECT="$STRIPE_WEBHOOK_SECRET_CONNECT" \
  STRIPE_CONNECT_RETURN_URL="$RETURN_URL" \
  STRIPE_CONNECT_REFRESH_URL="$REFRESH_URL" \
  STRIPE_PRICE_VENUE_FORMAL_PRO="$STRIPE_PRICE_VENUE_FORMAL_PRO" \
  STRIPE_PRICE_VENUE_INFORMAL_PRO="$STRIPE_PRICE_VENUE_INFORMAL_PRO" \
  STRIPE_PRICE_GUEST_SILVER="$STRIPE_PRICE_GUEST_SILVER" \
  STRIPE_PRICE_GUEST_GOLD="$STRIPE_PRICE_GUEST_GOLD" \
  STRIPE_PRICE_GUEST_DIAMOND="$STRIPE_PRICE_GUEST_DIAMOND" \
  STRIPE_MESITA_FEE_BPS="$STRIPE_MESITA_FEE_BPS"

# --- deploy Phase 3a EFs -------------------------------------------------

echo "▶ Deploying Phase 3a Edge Functions…"
supabase functions deploy manager-start-connect-onboarding
supabase functions deploy stripe-receive-connect-event

cat <<'EOF'

✓ Stripe sandbox setup complete.

What was set up:
  • Migration 0020 applied → 8 new tables (ledger + Stripe linkage)
  • EF secrets configured (11 vars)
  • Phase 3a EFs deployed:
      manager-start-connect-onboarding
      stripe-receive-connect-event

Next:
  • Test the Connect onboarding by calling
      POST /functions/v1/manager-start-connect-onboarding
      { "venueId": "<a Formal venue id>" }
    → expect { "ok": true, "onboardingUrl": "https://connect.stripe.com/…" }
  • Open the onboardingUrl in a browser, finish (or partially finish)
    Stripe-hosted KYC. Watch stripe_connect_accounts.details_submitted
    flip to true in the next 1-2 seconds (webhook delivery).
  • Ready for Phase 3b (manager UI integration) or Phase 4 (bill payment).
EOF
