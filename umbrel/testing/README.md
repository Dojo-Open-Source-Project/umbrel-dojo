# Smoke test

Runs the App Store package against a regtest Bitcoin node and checks it works.
No Umbrel required — just Docker and Python 3 with PyYAML.

```sh
./umbrel/testing/smoke-test.sh          # runs and tears down
KEEP=1 ./umbrel/testing/smoke-test.sh   # leaves it running to poke at
```

With `KEEP=1`, the Connect UI is at <http://localhost:3023> and the Dojo API at
<http://localhost:3024> (Maintenance Tool at `/admin/`). The admin key is in the
generated `.env`; the script prints the working directory it used.

The service definitions come from `umbrel/dojo/docker-compose.yml` verbatim, via
`compose-from-package.py`, so the test cannot drift from the package. Only what
umbrelOS itself supplies is added: injected container names, a regtest bitcoind
standing in for the Bitcoin Node app, and published ports.

## What it checks

- every container comes up as `1000:1000`, the UID umbrelOS runs apps as
- the schema is created, including the `api_keys` table added in Dojo 1.29
- nginx serves the Dojo API, the Maintenance Tool, and the network-specific
  admin config
- the Connect UI renders, with `conf.js` substituted from its template
- the derived admin key exchanges for a JWT, and the pairing and status
  endpoints answer
- the Tor hidden service is created from `torrc.template`
- Soroban bootstraps Tor and writes its peerstore into app data
- the tracker indexes a mined regtest block over ZMQ
- everything comes back after a restart, with the database intact

## What it does not check

This is **not** Umbrel verification, and a PR should not present it as such.
It does not exercise umbrelOS's installer, `app_proxy`, Umbrel auth, the
dependency picker, updates from a previously shipped version, or xpub
import and rescan — that last one needs a real Electrum server and a real
chain, so there is no electrs stand-in here.

For the real thing, see `umbrel-test-app` in
[getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps): rsync the
package into the App Store source directory on a device and install it through
Umbrel.
