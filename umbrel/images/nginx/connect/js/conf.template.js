// Rendered from conf.template.js by the container entrypoint (envsubst).
// Everything here is already visible to anyone who can open this page, which
// Umbrel keeps behind the user's Umbrel login.
var conf = {
  network: "$COMMON_BTC_NETWORK",
  chain: "$DOJO_CHAIN",
  dojoVersion: "$DOJO_VERSION_TAG",
  dojoHiddenService: "$DOJO_HIDDEN_SERVICE",
  publicExplorer: "$DOJO_PUBLIC_EXPLORER",
  dojoApiPort: "$DOJO_API_PORT",
  deviceDomainName: "$DEVICE_DOMAIN_NAME",
  adminKey: "$NODE_ADMIN_KEY",
  supportPrefix: "$NODE_PREFIX_SUPPORT",
  // PandoTx, reported read-only on the Advanced tab. Dojo reads these at
  // startup, so they cannot change while the app runs.
  pandoTxPush: "$NODE_PANDOTX_PUSH",
  pandoTxProcess: "$NODE_PANDOTX_PROCESS",
  sorobanAnnounce: "$SOROBAN_ANNOUNCE"
};
