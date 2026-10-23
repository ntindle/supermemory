#!/usr/bin/env bash
set -euo pipefail
patch=/data/postgres
upstream=/usr/local/bin/entrypoint.sh
[[ "${SUPERMEMORY_VERSION:-}" == 0.0.8 ]] || { echo 'Factory Postgres patch requires server 0.0.8' >&2; exit 1; }
[[ -n "${FACTORY_SUPERMEMORY_DATABASE_URL_FILE:-}" && -s "$FACTORY_SUPERMEMORY_DATABASE_URL_FILE" ]] || { echo 'Postgres connection file is required' >&2; exit 1; }
cd "$patch"
sha256sum --check --status runtime.sha256 || { echo 'Factory Postgres runtime checksum mismatch' >&2; exit 1; }
expected=$(cat launcher.sha256)
actual=$(sha256sum "$upstream")
[[ "${actual%% *}" == "$expected" ]] || { echo 'Launcher changed; validate the Postgres patch before upgrading' >&2; exit 1; }
export FACTORY_SUPERMEMORY_RUNTIME="${FACTORY_SUPERMEMORY_RUNTIME:-file:///data/postgres/runtime.mjs}"
export SUPERMEMORY_HIDE_API_KEY_IN_LOGS=1
generated=$(mktemp /tmp/factory-supermemory-launch.XXXXXXXX)
awk '
  /^exec "\$\{run_as\[@\]\}" "\$\{bin\}" "\$@"$/ {
    print "exec \"${run_as[@]}\" \"/data/postgres/bin/supermemory-server-0.0.8-postgres\" \"$@\""
    found++; next
  }
  { print }
  END { if (found != 1) exit 42 }
' "$upstream" > "$generated"
exec bash "$generated" "$@"
