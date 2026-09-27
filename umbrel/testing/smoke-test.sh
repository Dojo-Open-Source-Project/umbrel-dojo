#!/usr/bin/env bash
#
# Run the Dojo app package against a regtest Bitcoin node and check that it
# actually works. No Umbrel required -- just Docker.
#
#   ./umbrel/testing/smoke-test.sh
#
# This is NOT Umbrel verification. It proves the containers come up, talk to
# each other, serve the Connect UI and the Dojo API, index a block, and
# survive a restart. It does not exercise umbrelOS's installer, app_proxy,
# Umbrel auth, the dependency picker, or xpub import against a real indexer.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="${WORK_DIR:-${TMPDIR:-/tmp}/dojo-smoke-test}"
KEEP="${KEEP:-0}"

# Which package to test. Defaults to the App Store package; point it at a
# generated community store to check that variant, where the app id carries the
# store prefix and every injected container name moves with it:
#   PACKAGE_DIR=/tmp/umbrel-dojo-osp-store/dojo-osp-dojo ./umbrel/testing/smoke-test.sh
PACKAGE_DIR="${PACKAGE_DIR:-${REPO_ROOT}/umbrel/dojo}"

# Everything app-id-derived is read from the package rather than hardcoded.
APP_ID="$(sed -n 's/^id: *//p' "${PACKAGE_DIR}/umbrel-app.yml" | head -1)"
PROXY_PORT="$(sed -n 's/^port: *//p' "${PACKAGE_DIR}/umbrel-app.yml" | head -1)"
API_PORT="$(sed -n 's/.*APP_DOJO_API_PORT="\([0-9]*\)".*/\1/p' "${PACKAGE_DIR}/exports.sh" | head -1)"
NGINX_IP="$(sed -n 's/.*APP_DOJO_NGINX_IP="\([0-9.]*\)".*/\1/p' "${PACKAGE_DIR}/exports.sh" | head -1)"

CONNECT_URL="http://127.0.0.1:${PROXY_PORT}"
API_URL="http://127.0.0.1:${API_PORT}"

pass=0
fail=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

check() {
	# check <description> <command...>
	local description="$1"
	shift
	if "$@" > /dev/null 2>&1; then ok "$description"; else bad "$description"; fi
}

cleanup() {
	if [ "$KEEP" = "1" ]; then
		echo
		echo "Left running. Tear down with:"
		echo "  docker compose -f ${WORK_DIR}/docker-compose.yml down -v"
		return
	fi
	echo
	echo "Cleaning up..."
	docker compose -f "${WORK_DIR}/docker-compose.yml" down -v > /dev/null 2>&1 || true
	rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

step "Preparing ${WORK_DIR}"
rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}/app-data/data/mysql" \
         "${WORK_DIR}/app-data/data/soroban" \
         "${WORK_DIR}/tor-data" \
         "${WORK_DIR}/bitcoin"

# umbrelOS creates app data owned by 1000:1000 and runs the containers as that
# UID. Reproduce that, or the containers cannot write their own data.
if [ "$(id -u)" = "0" ]; then
	chown -R 1000:1000 "${WORK_DIR}/app-data" "${WORK_DIR}/tor-data" "${WORK_DIR}/bitcoin"
fi

python3 "${REPO_ROOT}/umbrel/testing/compose-from-package.py" \
	"${WORK_DIR}/docker-compose.yml" "${WORK_DIR}" "${PACKAGE_DIR}"

# Render the top-level templates the way umbrelOS does, into the app data dir.
APP_ID="${APP_ID}" APP_DOJO_NGINX_IP="${NGINX_IP}" \
	envsubst '$APP_ID $APP_DOJO_NGINX_IP' \
	< "${PACKAGE_DIR}/torrc.template" \
	> "${WORK_DIR}/app-data/torrc"
envsubst < "${PACKAGE_DIR}/soroban.env.template" \
	> "${WORK_DIR}/app-data/soroban.env"

# Stand-ins for Umbrel's env. The secrets are the same shape derive_entropy
# produces (64 hex characters).
hex32() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

ADMIN_KEY="$(hex32)"
cat > "${WORK_DIR}/.env" <<EOF
APP_DATA_DIR=${WORK_DIR}/app-data
TOR_DATA_DIR=${WORK_DIR}/tor-data
DEVICE_DOMAIN_NAME=umbrel.local
APP_DOJO_BTC_NETWORK=mainnet
APP_BITCOIN_NODE_IP=10.21.21.8
APP_BITCOIN_RPC_PORT=8332
APP_BITCOIN_RPC_USER=umbrel
APP_BITCOIN_RPC_PASS=testpassword
APP_BITCOIN_ZMQ_RAWTX_PORT=28333
APP_BITCOIN_ZMQ_HASHBLOCK_PORT=28334
APP_ELECTRS_NODE_IP=10.21.21.10
APP_ELECTRS_NODE_PORT=50001
TOR_PROXY_IP=10.21.21.11
TOR_PROXY_PORT=9050
APP_DOJO_NGINX_IP=${NGINX_IP}
APP_DOJO_API_PORT=${API_PORT}
APP_DOJO_SOROBAN_PORT=4242
APP_DOJO_HIDDEN_SERVICE=notyetset.onion
APP_DOJO_INDEXER_BATCH_SUPPORT=inactive
APP_DOJO_NODE_API_KEY=$(hex32)
APP_DOJO_NODE_ADMIN_KEY=${ADMIN_KEY}
APP_DOJO_NODE_JWT_SECRET=$(hex32)
APP_DOJO_MYSQL_PASSWORD=$(hex32)
APP_DOJO_MYSQL_ROOT_PASSWORD=$(hex32)
EOF

compose() { docker compose -f "${WORK_DIR}/docker-compose.yml" --env-file "${WORK_DIR}/.env" "$@"; }

step "Starting the stack"
compose up -d

# The tracker will not start while bitcoind reports zero blocks
# (tracker/blockchain-processor.js: `daemonNbHeaders === 0 || daemonNbBlocks === 0`),
# so give regtest a chain before Dojo gets going rather than at the end.
step "Mining 3 regtest blocks"
bcli() {
	docker exec ${APP_ID}_bitcoind_1 bitcoin-cli -regtest -rpcport=8332 \
		-rpcuser=umbrel -rpcpassword=testpassword "$@"
}
bcli -rpcwait createwallet smoketest > /dev/null 2>&1 || true
mining_address="$(bcli getnewaddress 2>/dev/null || true)"
if [ -n "${mining_address}" ] && bcli generatetoaddress 3 "${mining_address}" > /dev/null 2>&1; then
	ok "regtest chain has $(bcli getblockcount 2>/dev/null || echo '?') blocks"
else
	bad "could not mine regtest blocks"
fi

# /admin/ is proxied to the node's static file server, so a 200 there means
# Dojo is up, not just nginx. Dojo registers no route at `/`.
READY_URL="${API_URL}/admin/"

wait_for_ready() {
	for _ in $(seq 1 60); do
		if curl -sf "${READY_URL}" > /dev/null 2>&1; then return 0; fi
		sleep 5
	done
	return 1
}

step "Waiting for Dojo to come up (up to 5 minutes)"
wait_for_ready || echo "  timed out; checks below will show what came up"

step "Containers"
for service in db node soroban nginx tor bitcoind; do
	state="$(docker inspect -f '{{.State.Status}}' "dojo_${service}_1" 2>/dev/null || echo missing)"
	if [ "${state}" = "running" ]; then ok "${service} is running"; else bad "${service} is ${state}"; fi
done

step "Database"
check "schema created (api_keys table exists)" \
	docker exec ${APP_ID}_db_1 sh -c 'mariadb -uroot -p"${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" samourai-main -e "SELECT 1 FROM api_keys LIMIT 1"'

step "Dojo API (published on ${API_URL})"
check "nginx answers on the API port" \
	sh -c "curl -sf '${API_URL}/nonexistent' | grep -q '\"status\":\"ok\"'"
check "Maintenance Tool loads at /admin/ (proxied to Dojo)" curl -sf "${API_URL}/admin/"
check "network-specific admin config is served" \
	sh -c "curl -sf '${API_URL}/admin/conf/index.js' | grep -q adminTool"

step "Connect UI (published on ${CONNECT_URL})"
check "page loads" curl -sf "${CONNECT_URL}/"
check "conf.js rendered from the template" \
	sh -c "curl -sf '${CONNECT_URL}/js/conf.js' | grep -q 'dojoVersion: \"1.29.3\"'"
check "admin key reached the page" \
	sh -c "curl -sf '${CONNECT_URL}/js/conf.js' | grep -q '${ADMIN_KEY}'"

step "Authenticated API"
token="$(curl -sf -X POST "${CONNECT_URL}/v2/auth/login" \
	-d "apikey=${ADMIN_KEY}" 2>/dev/null \
	| python3 -c 'import json,sys; print(json.load(sys.stdin)["authorizations"]["access_token"])' 2>/dev/null || true)"
if [ -n "${token}" ]; then ok "admin key exchanges for a JWT"; else bad "admin key exchanges for a JWT"; fi

if [ -n "${token}" ]; then
	check "pairing payload reports version 1.29.3" \
		sh -c "curl -sf -H 'Authorization: Bearer ${token}' '${CONNECT_URL}/v2/support/pairing' | grep -q '\"version\": *\"1.29.3\"'"
	check "status endpoint returns JSON" \
		sh -c "curl -sf -H 'Authorization: Bearer ${token}' '${CONNECT_URL}/v2/status/' | grep -q uptime"
fi

step "Tor"
HOSTNAME_FILE="${WORK_DIR}/tor-data/app-${APP_ID}-api/hostname"
if [ -f "${HOSTNAME_FILE}" ]; then
	onion="$(cat "${HOSTNAME_FILE}")"
	ok "hidden service created ($(printf '%s' "${onion}" | cut -c1-16)...)"

	# exports.sh reads this file every time the app starts, so a first boot
	# has no onion yet and the next start picks it up. Reproduce that here,
	# otherwise the Connect page keeps showing "no Tor address yet".
	sed -i.bak "s|^APP_DOJO_HIDDEN_SERVICE=.*|APP_DOJO_HIDDEN_SERVICE=${onion}|" "${WORK_DIR}/.env"
	rm -f "${WORK_DIR}/.env.bak"
	compose up -d --force-recreate nginx > /dev/null 2>&1
	wait_for_ready || true

	check "Connect page advertises the real onion address" \
		sh -c "curl -sf '${CONNECT_URL}/js/conf.js' | grep -q '${onion}'"
else
	bad "hidden service created"
fi

step "Soroban"
check "Tor bootstrapped inside the soroban container" \
	sh -c "docker logs ${APP_ID}_soroban_1 2>&1 | grep -q 'Tor initialization complete'"
check "soroban RPC is up" \
	sh -c "docker logs ${APP_ID}_soroban_1 2>&1 | grep -q 'Soroban started'"
# Not checked: data/soroban/peerstore. Soroban only writes it once it has
# connected to peers over Tor, which takes minutes -- its absence early in a
# run means nothing.

step "Tracker"
# The tracker polls every 30s, so give it a couple of cycles.
indexed=0
for _ in $(seq 1 8); do
	indexed="$(docker exec ${APP_ID}_db_1 sh -c \
		'mariadb -N -uroot -p"${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" samourai-main -e "SELECT COUNT(*) FROM blocks"' \
		2>/dev/null | tr -d '[:space:]' || echo 0)"
	[ "${indexed:-0}" -ge 1 ] && break
	sleep 10
done
if [ "${indexed:-0}" -ge 1 ]; then
	ok "tracker indexed ${indexed} block(s) over ZMQ"
else
	bad "tracker indexed a block over ZMQ (see: docker logs ${APP_ID}_node_1)"
fi

step "Restart and persistence"
compose restart > /dev/null 2>&1
wait_for_ready || true
check "Dojo is back after restart" curl -sf "${READY_URL}"
check "database survived the restart" \
	docker exec ${APP_ID}_db_1 sh -c 'mariadb -uroot -p"${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" samourai-main -e "SELECT 1 FROM api_keys LIMIT 1"'

printf '\n\033[1m%d passed, %d failed\033[0m\n' "${pass}" "${fail}"

if [ "${KEEP}" = "1" ]; then
	cat <<EOF

Open in a browser:
  Connect UI          ${CONNECT_URL}
  Dojo API            ${API_URL}
  Maintenance Tool    ${API_URL}/admin/

Admin key (for the Maintenance Tool):
  ${ADMIN_KEY}

Working directory: ${WORK_DIR}
EOF
fi

[ "${fail}" -eq 0 ]
