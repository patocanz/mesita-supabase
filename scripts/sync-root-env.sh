#!/usr/bin/env bash
# Copy Twilio vars from .env.twilio.local → .env (project root).
# Supabase CLI reads .env for config.toml env(TWILIO_*) — see supabase/config.toml [auth.sms.twilio].
#
# Run after editing .env.twilio.local:
#   ./scripts/sync-root-env.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/.env.twilio.local"
DEST="${ROOT}/.env"

if [[ ! -f "${SRC}" ]]; then
  echo "Missing ${SRC}. Copy from .env.twilio.local.example"
  exit 1
fi

# shellcheck disable=SC1091
source "${ROOT}/scripts/_load-local-env.sh"

for key in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_MESSAGE_SERVICE_SID; do
  val="${!key:-}"
  if [[ -z "${val}" ]]; then
    echo "Missing ${key} in ${SRC}"
    exit 1
  fi
done

touch "${DEST}"
tmp="$(mktemp)"
if [[ -f "${DEST}" ]]; then
  grep -v '^TWILIO_ACCOUNT_SID=' "${DEST}" 2>/dev/null | grep -v '^TWILIO_AUTH_TOKEN=' | grep -v '^TWILIO_MESSAGE_SERVICE_SID=' | grep -v '^# Twilio (synced from .env.twilio.local)' > "${tmp}" || true
else
  : > "${tmp}"
fi

{
  cat "${tmp}"
  echo "# Twilio (synced from .env.twilio.local by scripts/sync-root-env.sh)"
  echo "TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID}"
  echo "TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}"
  echo "TWILIO_MESSAGE_SERVICE_SID=${TWILIO_MESSAGE_SERVICE_SID}"
} > "${DEST}.next"
mv "${DEST}.next" "${DEST}"
rm -f "${tmp}"

echo "OK Wrote Twilio vars to ${DEST}"
