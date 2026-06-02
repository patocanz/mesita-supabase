# shellcheck shell=bash
# Source local env for mesita-supabase scripts. Not executed directly.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${ROOT}/.env.twilio.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT}/.env.twilio.local"
  set +a
fi
