#!/bin/sh
#
# Select the network-specific Dojo API config, render the Connect UI config
# from its template, wait for the Dojo node to accept connections, then hand
# over to nginx.
#
set -eu

SITES_DIR=/etc/nginx/sites-enabled
CONNECT_DIR=/var/www/connect

: "${COMMON_BTC_NETWORK:=bitcoin}"
: "${DOJO_VERSION_TAG:=}"
: "${DOJO_API_PORT:=}"
: "${DOJO_HIDDEN_SERVICE:=notyetset.onion}"
: "${DEVICE_DOMAIN_NAME:=umbrel.local}"
: "${NODE_ADMIN_KEY:=}"
: "${NODE_PREFIX_SUPPORT:=support}"
: "${NODE_HOST:=node}"
: "${NODE_WAIT_TIMEOUT:=720}"

if [ "$COMMON_BTC_NETWORK" = "testnet" ]; then
    cp /etc/nginx/available/dojo-testnet.conf "$SITES_DIR/dojo.conf"
else
    cp /etc/nginx/available/dojo-mainnet.conf "$SITES_DIR/dojo.conf"
fi
cp /etc/nginx/available/connect.conf "$SITES_DIR/connect.conf"

# Only the variables listed here are substituted, so anything else that looks
# like a shell variable in the template survives untouched.
envsubst '$COMMON_BTC_NETWORK $DOJO_VERSION_TAG $DOJO_API_PORT $DOJO_HIDDEN_SERVICE $DEVICE_DOMAIN_NAME $NODE_ADMIN_KEY $NODE_PREFIX_SUPPORT' \
    < "$CONNECT_DIR/js/conf.template.js" \
    > "$CONNECT_DIR/js/conf.js"

exec /wait-for "${NODE_HOST}:8080" --timeout="$NODE_WAIT_TIMEOUT" -- nginx
