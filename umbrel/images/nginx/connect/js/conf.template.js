// Rendered from conf.template.js by the container entrypoint (envsubst).
// Everything here is already visible to anyone who can open this page, which
// Umbrel keeps behind the user's Umbrel login.
var conf = {
  network: "$COMMON_BTC_NETWORK",
  dojoVersion: "$DOJO_VERSION_TAG",
  dojoApiPort: "$DOJO_API_PORT",
  dojoHiddenService: "$DOJO_HIDDEN_SERVICE",
  deviceDomainName: "$DEVICE_DOMAIN_NAME",
  adminKey: "$NODE_ADMIN_KEY",
  supportPrefix: "$NODE_PREFIX_SUPPORT"
};
