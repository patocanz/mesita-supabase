#!/usr/bin/env bash
# Point WhatsApp senders at Supabase webhook Edge Functions.
# Requires Senders API access on your account.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "${ROOT}/.env.twilio.local" ]]; then
  # shellcheck disable=SC1091
  set -a && source "${ROOT}/.env.twilio.local" && set +a
fi

ACCOUNT_SID="${TWILIO_ACCOUNT_SID:?Set TWILIO_ACCOUNT_SID}"
AUTH_TOKEN="${TWILIO_AUTH_TOKEN:?Set TWILIO_AUTH_TOKEN}"
PROJECT_REF="${SUPABASE_PROJECT_REF:-yjalywfzdelacdzccpgb}"
INBOUND="https://${PROJECT_REF}.supabase.co/functions/v1/twilio-whatsapp-inbound"
STATUS="https://${PROJECT_REF}.supabase.co/functions/v1/twilio-whatsapp-status"
TARGET="${TWILIO_PHONE_NUMBERS:-+16282968794,+16282964968}"

echo "==> Inbound:  ${INBOUND}"
echo "==> Status:   ${STATUS}"
echo ""

IFS=',' read -ra PHONES <<< "${TARGET}"
for PHONE in "${PHONES[@]}"; do
  PHONE="${PHONE// /}"
  WA="whatsapp:${PHONE}"
  echo "→ ${WA}"
  # List senders and match by sender_id
  LIST=$(curl -sS -u "${ACCOUNT_SID}:${AUTH_TOKEN}" \
    "https://messaging.twilio.com/v2/Channels/Senders?PageSize=100")
  SID=$(echo "$LIST" | PHONE="$WA" python3 -c "
import json, os, sys
want = os.environ['PHONE']
for s in json.load(sys.stdin).get('senders', []):
    if s.get('sender_id') == want:
        print(s['sid']); break
")
  if [[ -z "${SID}" ]]; then
    echo "    ✗ sender not found (register in Console first)" >&2
    continue
  fi
  HTTP=$(curl -sS -o /tmp/twilio-sender.json -w "%{http_code}" -u "${ACCOUNT_SID}:${AUTH_TOKEN}" \
    -X POST "https://messaging.twilio.com/v2/Channels/Senders/${SID}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "Webhook.CallbackUrl=${INBOUND}" \
    -d "Webhook.CallbackMethod=POST" \
    -d "Webhook.StatusCallbackUrl=${STATUS}" \
    -d "Webhook.StatusCallbackMethod=POST")
  if [[ "${HTTP}" == "200" || "${HTTP}" == "201" ]]; then
    echo "    ✓ webhooks updated (${SID})"
  else
    echo "    ✗ HTTP ${HTTP}" >&2
    cat /tmp/twilio-sender.json >&2
  fi
done

echo ""
echo "Deploy EFs first: supabase functions deploy twilio-whatsapp-inbound twilio-whatsapp-status"
