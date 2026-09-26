#!/bin/sh

# PM2 has to be installed as a globally available binary

# Use `reload` instead of `restart` for graceful 0-downtime reload
# Use mainnet or testnet, dependning on the `NAMESPACE` defined in pm2.config.cjs
pm2 reload mainnet

# to apply chnages like new interpreter, for example when switching to new node.js version,
# the scripts have to be restarted via PM2 config file like:
# cd /path-to-app
# pm2 reload pm2.config.cjs --update-env
