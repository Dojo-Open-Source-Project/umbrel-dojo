# Dojo follows whichever chain your Bitcoin Node is set to -- it has no network
# of its own to choose, and pointing it at a chain its bitcoind is not on would
# only index nonsense.
#
# Two names come out of this, because Dojo collapses more than we can afford to.
# Dojo itself knows exactly two networks: keys.index.js reduces COMMON_BTC_NETWORK
# to "testnet" or "bitcoin", and lib/bitcoin/network.js then picks bitcoinjs-lib's
# testnet or mainnet parameters. testnet3, testnet4 and signet all share testnet's
# address encoding, so all three work under Dojo's "testnet" -- but they are
# different chains, and their indexed data must never be mixed. So:
#
#   APP_DOJO_BTC_NETWORK  what Dojo, nginx and the Connect page see: mainnet|testnet
#   APP_DOJO_CHAIN        the real chain, which keys the on-disk data
#
# regtest is the one we genuinely cannot serve: it uses bcrt1 addresses, and
# bitcoinjs-lib's testnet parameters would derive the wrong ones.
case "${APP_BITCOIN_NETWORK-mainnet}" in
	mainnet)
		export APP_DOJO_BTC_NETWORK="mainnet"
		export APP_DOJO_CHAIN="mainnet"
		;;
	testnet | testnet4 | signet)
		export APP_DOJO_BTC_NETWORK="testnet"
		export APP_DOJO_CHAIN="${APP_BITCOIN_NETWORK}"
		;;
	*)
		echo "Warning (${EXPORTS_APP_ID}): Dojo cannot run against '${APP_BITCOIN_NETWORK}' -- it supports mainnet, testnet, testnet4 and signet. Set your Bitcoin Node to one of those; Dojo is staying on mainnet until you do."
		export APP_DOJO_BTC_NETWORK="mainnet"
		export APP_DOJO_CHAIN="mainnet"
		;;
esac

# Static addresses. Only the nginx container needs a fixed IP: Tor's
# HiddenServicePort target is resolved from torrc, where a container name is
# not dependable. Everything else talks over Docker DNS.
export APP_DOJO_NGINX_IP="10.21.21.31"

# Host port for the Dojo API, so wallets on the same network can reach it
# without going through Tor or Umbrel's app proxy.
export APP_DOJO_API_PORT="3024"

# Soroban RPC, internal to the app.
export APP_DOJO_SOROBAN_PORT="4242"

# Tor address of the Dojo API, used for wallet pairing.
dojo_hidden_service_file="${EXPORTS_TOR_DATA_DIR}/app-${EXPORTS_APP_ID}-api/hostname"
export APP_DOJO_HIDDEN_SERVICE="$(cat "${dojo_hidden_service_file}" 2>/dev/null || echo "notyetset.onion")"

# Per-install secrets. Deterministic, so they survive restarts and updates
# without being stored anywhere.
export APP_DOJO_NODE_API_KEY="$(derive_entropy "${app_entropy_identifier}-node-api-key")"
export APP_DOJO_NODE_ADMIN_KEY="$(derive_entropy "${app_entropy_identifier}-node-admin-key")"
export APP_DOJO_NODE_JWT_SECRET="$(derive_entropy "${app_entropy_identifier}-node-jwt-secret")"
export APP_DOJO_MYSQL_PASSWORD="$(derive_entropy "${app_entropy_identifier}-mysql-password")"
export APP_DOJO_MYSQL_ROOT_PASSWORD="$(derive_entropy "${app_entropy_identifier}-mysql-root-password")"

# The electrs dependency can be satisfied by Umbrel's electrs app or by any app
# that implements it. Fulcrum serves batched Electrum requests and Dojo imports
# and rescans are much faster with them; romanz/electrs does not, and asking it
# for batches breaks the import. Both export APP_ELECTRS_NODE_IP/PORT, so the
# presence of Fulcrum's own exports is what tells them apart.
if [ -n "${APP_FULCRUM_NODE_IP-}" ]; then
	export APP_DOJO_INDEXER_BATCH_SUPPORT="active"
else
	export APP_DOJO_INDEXER_BATCH_SUPPORT="inactive"
fi
