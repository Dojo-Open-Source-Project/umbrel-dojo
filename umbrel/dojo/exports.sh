# Dojo only knows two networks. Umbrel's Bitcoin Node can also be set to
# testnet4, signet or regtest, none of which Dojo supports, so say so rather
# than quietly running against the wrong chain.
case "${APP_BITCOIN_NETWORK-mainnet}" in
	mainnet) export APP_DOJO_BTC_NETWORK="mainnet" ;;
	testnet) export APP_DOJO_BTC_NETWORK="testnet" ;;
	*)
		echo "Warning (${EXPORTS_APP_ID}): Dojo supports mainnet and testnet only; your Bitcoin Node is set to '${APP_BITCOIN_NETWORK}'. Dojo will run against mainnet and will not sync."
		export APP_DOJO_BTC_NETWORK="mainnet"
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
