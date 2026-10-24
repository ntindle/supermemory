#!/usr/bin/env bash
# Owns only its temporary directory and uniquely named disposable PG container.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="${repo_root}/patches/postgres"
bun_bin="${BUN_BIN:-bun}"
test_dir="$(mktemp -d /tmp/factory-postgres-test.XXXXXXXX)"
container="factory-postgres-test-${test_dir##*.}"
cleanup() {
  docker rm --force --volumes "${container}" >/dev/null 2>&1 || true
  rm -rf -- "${test_dir}"
}
trap cleanup EXIT
umask 077
openssl rand -hex 32 > "${test_dir}/password"
image="$("${bun_bin}" -e 'console.log((await Bun.file(process.argv[1]).json()).postgresImage)' "${package}/pins.json")"
docker run --detach --name "${container}" --restart=no \
  --memory 1g --cpus 2 --shm-size 256m \
  --publish 127.0.0.1::5432 \
  --volume "${test_dir}:${test_dir}" \
  --env POSTGRES_PASSWORD_FILE="${test_dir}/password" \
  "${image}" -c log_min_error_statement=panic >/dev/null
healthy=false
for _ in $(seq 1 60); do
  if docker exec "${container}" pg_isready --quiet --username postgres; then healthy=true; break; fi
  sleep 1
done
[[ "${healthy}" == true ]] || { echo 'Temporary PostgreSQL did not become ready' >&2; exit 1; }
port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "${container}")"
"${bun_bin}" - "${test_dir}" "${port}" <<'JS'
import fs from "node:fs";
const [dir, port] = process.argv.slice(2);
const url = new URL(`postgresql://postgres@127.0.0.1:${port}/postgres`);
url.password = fs.readFileSync(`${dir}/password`, "utf8").trim();
fs.writeFileSync(`${dir}/url`, url.toString(), { flag: "wx", mode: 0o600 });
JS
export FACTORY_TEST_PG_URL_FILE="${test_dir}/url"
export FACTORY_TEST_SHARED_DIR="${test_dir}"
export FACTORY_TEST_PG_CONTAINER="${container}"
cd "${package}"
"${bun_bin}" install --frozen-lockfile
"${bun_bin}" test
"${bun_bin}" run format:check
