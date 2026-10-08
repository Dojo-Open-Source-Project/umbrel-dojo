#!/usr/bin/env bash
#
# exports.sh tests.
#
#   ./umbrel/testing/exports-test.sh
#
# umbreld sources every installed app's exports.sh whenever an app that depends
# on it starts (legacy-compat/app-script, source_app). Inside that loop
# EXPORTS_APP_ID names the app whose exports are being read, but
# app_entropy_identifier names the app being *started*:
#
#     local -r app_entropy_identifier="app-${app}-seed"
#     for EXPORTS_APP_ID in $APPS_TO_SOURCE; do . "${EXPORTS_APP_FILE}"; done
#
# So a secret derived from app_entropy_identifier comes out different depending
# on which app happens to be starting. These tests stub derive_entropy to echo
# its identifier, then source exports.sh the way umbreld does, from Dojo itself
# and from a dependent.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exports="${EXPORTS_FILE:-${here}/../dojo/exports.sh}"

passed=0
failed=0

check() {
	local name="$1" got="$2" want="$3"
	if [[ "${got}" == "${want}" ]]; then
		passed=$((passed + 1))
		printf '  \033[32mPASS\033[0m  %s\n' "${name}"
	else
		failed=$((failed + 1))
		printf '  \033[31mFAIL\033[0m  %s\n         got:  %s\n         want: %s\n' "${name}" "${got}" "${want}"
	fi
}

# Source exports.sh in a clean subshell, as umbreld would for one app starting,
# and print the five derived secrets one per line.
secrets() {
	local starting="$1" exporting="$2"
	(
		derive_entropy() { printf '%s' "$1"; }
		app_entropy_identifier="app-${starting}-seed"
		EXPORTS_APP_ID="${exporting}"
		EXPORTS_TOR_DATA_DIR="/nonexistent"
		APP_BITCOIN_NETWORK="mainnet"
		# shellcheck disable=SC1090
		. "${exports}" >/dev/null
		printf '%s\n' \
			"${APP_DOJO_NODE_API_KEY}" \
			"${APP_DOJO_NODE_ADMIN_KEY}" \
			"${APP_DOJO_NODE_JWT_SECRET}" \
			"${APP_DOJO_MYSQL_PASSWORD}" \
			"${APP_DOJO_MYSQL_ROOT_PASSWORD}"
	)
}

printf '\nexports.sh\n'

for id in dojo dojo-osp-dojo; do
	# What every install derived before the fix, when the only app ever
	# sourcing these exports was Dojo itself. These must not move: they are
	# the API key wallets were paired with and the MariaDB passwords the
	# database was created with.
	want="$(printf '%s\n' \
		"app-${id}-seed-node-api-key" \
		"app-${id}-seed-node-admin-key" \
		"app-${id}-seed-node-jwt-secret" \
		"app-${id}-seed-mysql-password" \
		"app-${id}-seed-mysql-root-password")"

	check "${id}: started on its own, every secret matches what existing installs derived" \
		"$(secrets "${id}" "${id}")" "${want}"

	check "${id}: sourced by a dependent app, every secret is still Dojo's own" \
		"$(secrets "some-other-app" "${id}")" "${want}"
done

printf '\n%d passed, %d failed\n\n' "${passed}" "${failed}"
[[ "${failed}" -eq 0 ]]
