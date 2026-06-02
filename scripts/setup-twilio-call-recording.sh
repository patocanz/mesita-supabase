#!/usr/bin/env bash
# Sync record-incoming TwiML to bin EHfd33... and set voice URL on target numbers.
# Usage: ./scripts/setup-twilio-call-recording.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "${ROOT}/.env.twilio.local" ]]; then
  # shellcheck disable=SC1091
  set -a && source "${ROOT}/.env.twilio.local" && set +a
fi

ACCOUNT_SID="${TWILIO_ACCOUNT_SID:?Set TWILIO_ACCOUNT_SID in .env.twilio.local}"
AUTH_TOKEN="${TWILIO_AUTH_TOKEN:?Set TWILIO_AUTH_TOKEN in .env.twilio.local}"
BIN_SID="${TWILIO_RECORDING_BIN_SID:-EHfd33bff85448c2a934494625fb70d808}"
TARGET_NUMBERS="${TWILIO_PHONE_NUMBERS:-+16282968794,+16282964968}"
TWIML_FILE="${ROOT}/integrations/twilio/twiml/record-incoming.xml"
BIN_URL="https://handler.twilio.com/twiml/${BIN_SID}"

API="https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}"
AUTH="${ACCOUNT_SID}:${AUTH_TOKEN}"

twilio_get() {
  local url="$1" tmp http
  tmp=$(mktemp)
  http=$(curl -sS -u "${AUTH}" -o "${tmp}" -w "%{http_code}" "${url}") || { rm -f "${tmp}"; return 1; }
  if [[ "${http}" != "200" ]]; then
    echo "ERROR: GET ${url} → HTTP ${http}" >&2
    cat "${tmp}" >&2
    rm -f "${tmp}"
    return 1
  fi
  cat "${tmp}"
  rm -f "${tmp}"
}

twilio_post() {
  local url="$1" tmp http
  shift
  tmp=$(mktemp)
  http=$(curl -sS -u "${AUTH}" -o "${tmp}" -w "%{http_code}" -X POST "${url}" "$@") || { rm -f "${tmp}"; return 1; }
  if [[ "${http}" != "200" && "${http}" != "201" ]]; then
    echo "ERROR: POST ${url} → HTTP ${http}" >&2
    cat "${tmp}" >&2
    rm -f "${tmp}"
    return 1
  fi
  cat "${tmp}"
  rm -f "${tmp}"
}

echo "==> TwiML source: ${TWIML_FILE} (sync bin ${BIN_SID} in Console if changed)"
echo "    Voice URL: ${BIN_URL}"
echo "==> Numbers: ${TARGET_NUMBERS}"
echo ""

UPDATED=0
IFS=',' read -ra PHONES <<< "${TARGET_NUMBERS}"
for PHONE in "${PHONES[@]}"; do
  PHONE="${PHONE// /}"
  [[ -z "${PHONE}" ]] && continue
  echo "→ ${PHONE}"
  LOOKUP=$(twilio_get "${API}/IncomingPhoneNumbers.json?PhoneNumber=${PHONE}")
  PN_SID=$(echo "${LOOKUP}" | python3 -c "
import json, sys
nums = json.load(sys.stdin).get('incoming_phone_numbers', [])
print(nums[0]['sid'] if nums else '')
")
  if [[ -z "${PN_SID}" ]]; then
    echo "    ✗ not found" >&2
    continue
  fi
  twilio_post "${API}/IncomingPhoneNumbers/${PN_SID}.json" \
    --data-urlencode "VoiceUrl=${BIN_URL}" \
    --data-urlencode "VoiceMethod=POST" >/dev/null
  echo "    ✓ voice webhook set"
  UPDATED=$((UPDATED + 1))
done

echo ""
echo "Done — ${UPDATED} number(s). Recordings: https://console.twilio.com/us1/monitor/logs/call-recordings"
