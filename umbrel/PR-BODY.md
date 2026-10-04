<!--
Draft body for the getumbrel/umbrel-apps pull request. It lives outside
umbrel/dojo/ on purpose: that directory is copied verbatim into the app store.

Before opening the PR:
  - set `submission:` in umbrel-app.yml to the PR's own URL
  - if the packaging repo has moved to the Dojo Open Source Project org by
    then, update the image names and the repo link below to match
  - attach screenshots of the app and the Dojo logo (do not commit gallery or
    icon assets; Umbrel produces those)
  - check "Testing performed" still matches what has actually been run,
    including which architectures
-->

# Dojo 1.29.3

Adds [Dojo](https://github.com/Dojo-Open-Source-Project/samourai-dojo), the private
wallet backend maintained by the Dojo Open Source Project, as a new app.

## Why a new app id instead of updating `samourai-server`

`samourai-server` is pinned to Dojo 1.16.1 (July 2022) on MariaDB 10.7, and its
images are personal builds from three different Docker Hub accounts. Upstream is
now 1.29.3 on MariaDB 12.1, with Node 24, migrated `@dojo-tools/*` dependencies
and a changed schema. There is no supported in-place upgrade across that many
MariaDB majors on a Raspberry Pi, and an update that silently corrupts a user's
index is worse than a fresh install.

So this ships as `dojo`. Existing `samourai-server` installs are untouched and
keep working. Anyone who wants 1.29.3 installs the new app and re-pairs. Happy to
follow up on deprecating the old package however you'd prefer.

The name drops "Samourai Server" too. Whirlpool's coordinator was shut down in
2024, Samourai Wallet's servers went with it, and the software people actually
run today is Dojo, maintained by the Dojo Open Source Project.

## Upstream

- Project: https://github.com/Dojo-Open-Source-Project/samourai-dojo
- Version packaged: `v1.29.3` (commit `8d5d0325`)
- Release notes: https://github.com/Dojo-Open-Source-Project/samourai-dojo/blob/master/RELEASES.md
- License: AGPL-3.0-only

## Images

Upstream publishes no images. Its compose file sets `pull_policy: never` and
builds everything locally via `dojo.sh`. The five images here are built by CI from
a pinned, vendored copy of upstream `v1.29.3` at
https://github.com/linkinparkrulz/umbrel-dojo, which documents every delta against
that tag in `UMBREL.md`. They are published to GHCR as multi-arch manifest lists
(`linux/amd64` + `linux/arm64`), pinned here by index digest, and pull anonymously.

| Service | Image | Built from |
|---|---|---|
| `node` | `ghcr.io/linkinparkrulz/dojo-nodejs` | upstream `docker/my-dojo/node/Dockerfile` |
| `db` | `ghcr.io/linkinparkrulz/dojo-db` | upstream `docker/my-dojo/mysql/Dockerfile` |
| `soroban` | `ghcr.io/linkinparkrulz/dojo-soroban` | upstream `docker/my-dojo/soroban/Dockerfile` |
| `nginx` | `ghcr.io/linkinparkrulz/dojo-nginx` | this packaging repo: the Dojo API proxy and the app's own page |
| `widget` | `ghcr.io/linkinparkrulz/dojo-widget` | this packaging repo: the home-screen fee widget |

### Source deltas against upstream

Four, each documented in `UMBREL.md` with the failure it fixes. All but the
explorer links are worth upstreaming, and are being reported.

1. **MariaDB image file modes**, `0440`/`0550` → `0444`/`0555`. Upstream
   tightened them in 1.29.3 assuming root or the `mysql` group. Under
   `user: "1000:1000"` the entrypoint cannot read its own init SQL and the
   container exits before creating the schema.
2. **`lib/auth/auth-rest-api.js`**: guard the Soroban auth47 verifier on the
   hostname, as the verifier three lines above already is. Without the guard,
   Dojo cannot start at all when it has no onion address (see below).
3. **`static/admin/lib/common-script.js`**: build transaction links for
   `explorer.mempool_space`, which the Maintenance Tool otherwise leaves blank.
4. **`docker/my-dojo/node/keys.index.js`**: wrap the two remaining unguarded
   onion-hostname reads in try/catch, matching the one upstream already guards.
   Unguarded, turning on Soroban's inbound announce killed every Dojo process at
   module load.

The Soroban image is also built with `SOROBAN_LINUX_UID/GID=1000` (upstream's
default is 1111), a build argument rather than a source change, so it can run as
`1000:1000` and write its own data directory.

## Package notes

- **`app_proxy`** fronts the app's page (nginx `:8081`) with Umbrel auth left on.
  That page shows the Dojo admin key and the pairing codes, so it belongs behind
  the user's Umbrel login.
- **One published port**, `3024`, for the Dojo API, so wallets on the same
  network can reach it without Tor. The page itself is not published.
- **Dependencies** are `bitcoin`, `electrs` and `mempool`.
  - Fulcrum declares `implements: electrs`, so either indexer satisfies the
    dependency. `exports.sh` detects which one the user selected and turns on
    batched Electrum requests only for Fulcrum. romanz/electrs does not serve
    them, and asking it for batches breaks xpub imports.
  - Mempool is the block explorer that the wallet pairing code points wallets
    at. Until the user turns on Tor in umbrelOS, so that Mempool has an onion,
    the code points at mempool.space's public onion instead, and the app's page
    says which one is in use.
- **The app's own page** replaces Dojo's Maintenance Tool for everyday use:
  - chain and service status;
  - next-block fee estimates, from the estimator Dojo already runs;
  - a separate, revocable API key per paired wallet, using Dojo's own
    `api_keys` table;
  - wallet and address lookup;
  - wallet, address and block-range rescans with live progress, the latter from
    the tracker's own websocket block events.

  The Maintenance Tool is still reachable over Tor.
- **Home-screen widget**: `three-stats`, showing next-block fee rates at 10%, 50%
  and 99% probability. A small sidecar serves it on an unpublished port.
- **User settings**: three `environment:` entries: PandoTx broadcast (on by
  default), relaying other people's transactions, and Soroban's inbound announce
  (both off by default). Dojo reads these once at startup, so umbrelOS's
  apply-and-restart is the right mechanism, and the page reports which are in
  force.
- **Secrets** (Dojo API key, admin key, JWT secret, both MariaDB passwords) are
  all per-install `derive_entropy` values. Nothing is hardcoded.
- **Chains**: Dojo follows the Bitcoin Node's chain. Mainnet, testnet, testnet4
  and signet are supported, each with its own on-disk data. Regtest is not: its
  `bcrt1` addresses do not match Dojo's testnet parameters, so `exports.sh` warns
  and stays on mainnet rather than indexing the wrong chain.
- **One hook**, `pre-start`. It creates the hidden-service and data directories
  and writes the explorer hostname file that Dojo reads at startup. There are no
  host mounts outside the app's own directories, no privileged containers and no
  Docker socket.
- Persistent state is `data/mysql` (the index), `data/soroban` (peerstore and
  onion key) and `data/explorer` (one hostname file).

## Testing performed

**On umbrelOS**, installed from a community app store generated from this
package, on [architecture: fill in]:

- install, update across many revisions, and restart, with the index surviving
  each
- the dependency picker, `app_proxy` and Umbrel auth in front of the page
- pairing a wallet over Tor from the QR code, including with per-wallet keys
  minted from the page
- the home-screen widget rendering live fee rates
- Soroban announce and relaying switched on from umbrelOS app settings, with
  Dojo starting cleanly and Soroban publishing its onion

**Locally**, the published images against a regtest Bitcoin node
(`umbrel/testing/smoke-test.sh` in the packaging repo), on linux/amd64:

- all containers start and stay up as `1000:1000`
- MariaDB initialises the full schema, including the `api_keys` table new in 1.29
- the derived admin key exchanges for a JWT, and the pairing and status
  endpoints answer
- the Tor hidden service is created from `torrc.template` and reaches the page
- Soroban bootstraps Tor and its RPC comes up
- the tracker indexes a mined block over ZMQ
- the app survives a restart with its database intact

The page and the widget server also have their own test suites in the packaging
repo, which check the page's behaviour against the response shapes Dojo actually
sends.

## Note for reviewers: an upstream bug this package works around

Dojo 1.29.3 cannot start at all when it has no onion address at
`/var/lib/tor/hsv3dojo/hostname`. `lib/auth/auth-rest-api.js` guards one auth47
verifier on the hostname. Three lines below, it constructs a second one
unguarded; with no hostname, that evaluates `new URL()` with no base and throws
at module load, which kills the Accounts process before it can listen. The
request handler already checks `if (!verifierSoroban)` and answers "Auth47 not
enabled", so a null verifier is the expected state and the guard was simply
left out.

MyDojo shares `/var/lib/tor` with its own Tor container, so upstream never hits
this. This package handles it in two ways: it carries the one-line guard as a
documented delta, and it bind-mounts the hidden service into the node container
so auth47 works with the real onion.

## Lint

`npm run lint:apps -- dojo --check-images`: clean.
