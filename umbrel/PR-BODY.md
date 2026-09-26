<!--
Draft body for the getumbrel/umbrel-apps pull request. It lives outside
umbrel/dojo/ on purpose: that directory is copied verbatim into the app store.

Before opening the PR:
  - replace the four placeholder image digests in docker-compose.yml with the
    published ones
  - set `submission:` in umbrel-app.yml to the PR's own URL
  - attach screenshots of the Connect page and the Dojo logo (do not commit
    gallery or icon assets)
  - fill in the "Testing performed" section with what you actually ran
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
keep working; anyone who wants 1.29.3 installs the new app and re-pairs. Happy to
follow up on deprecating the old package however you'd prefer.

The name drops "Samourai Server" too. Whirlpool's coordinator was shut down in
2024, Samourai Wallet is gone, and the software people actually run today is
Dojo, maintained by the Dojo Open Source Project.

## Upstream

- Project: https://github.com/Dojo-Open-Source-Project/samourai-dojo
- Version packaged: `v1.29.3` (commit `8d5d0325`)
- Release notes: https://github.com/Dojo-Open-Source-Project/samourai-dojo/blob/master/RELEASES.md
- License: AGPL-3.0-only

## Images

Upstream publishes no images — its compose file sets `pull_policy: never` and
builds everything locally via `dojo.sh`. The four images here are built from a
pinned vendored copy of upstream `v1.29.3` at
https://github.com/linkinparkrulz/umbrel-dojo, which documents every delta
against that tag in `UMBREL.md`, and are published to GHCR as multi-arch
manifest lists:

| Service | Image | Built from |
|---|---|---|
| `node` | `ghcr.io/linkinparkrulz/dojo-nodejs` | upstream `docker/my-dojo/node/Dockerfile` |
| `db` | `ghcr.io/linkinparkrulz/dojo-db` | upstream `docker/my-dojo/mysql/Dockerfile` |
| `soroban` | `ghcr.io/linkinparkrulz/dojo-soroban` | upstream `docker/my-dojo/soroban/Dockerfile` |
| `nginx` | `ghcr.io/linkinparkrulz/dojo-nginx` | this packaging repo |

There are exactly two source deltas against upstream, both documented:

- The mysql image's file modes go from `0440`/`0550` to `0444`/`0555`. Upstream
  tightened them in 1.29.3 assuming root or the `mysql` group; under Umbrel's
  `user: "1000:1000"` the entrypoint cannot read its own init SQL and the
  container exits 1 before creating the schema. Worth upstreaming.
- The Soroban image is built with `SOROBAN_LINUX_UID/GID=1000` (upstream default
  1111) so it can run as `1000:1000` and write its data directory and Tor state.

## Package notes

- **`app_proxy`** fronts the Connect page (nginx `:8081`) with Umbrel auth left
  on. The page renders the Dojo admin key and the pairing QR, so it should be
  behind the user's Umbrel login.
- **One published port**, `3024`, for the Dojo API, so wallets on the same
  network can reach it without Tor. The Connect UI is not published.
- **Dependencies** are `bitcoin` and `electrs`. Fulcrum declares
  `implements: electrs`, so either satisfies it. `exports.sh` detects which one
  the user selected and enables batched Electrum requests only for Fulcrum —
  romanz/electrs does not serve them, and asking it for batches breaks xpub
  imports.
- **Secrets** (Dojo API key, admin key, JWT secret, both MariaDB passwords) are
  all per-install `derive_entropy` values.
- **Soroban / PandoTx**: outgoing transactions are relayed by a random Soroban
  node rather than this one, so the broadcasting node is not linkable to the
  sender. `SOROBAN_ANNOUNCE` is off — the node does not publish itself as a
  public relay, which seemed the wrong default for a home server.
- **Network handling**: Umbrel's Bitcoin Node can be set to testnet4, signet or
  regtest, none of which Dojo supports. `exports.sh` maps mainnet and testnet and
  warns on anything else instead of silently running against the wrong chain.
- **No hooks**, no host mounts, no privileged containers, no Docker socket.
- Persistent state is `data/mysql` (the index) and `data/soroban` (peerstore).

## Testing performed

<!-- Replace with what you actually ran. -->

- umbrelOS version:
- Device / architecture:
- Fresh install with Bitcoin Node + Electrs: pairing QR scanned by <wallet>, xpub imported and synced
- Fresh install with Bitcoin Node + Fulcrum: batched imports confirmed
- Tor hidden service reachable, Maintenance Tool loads at `/admin/`
- Transaction pushed and relayed through PandoTx
- App restarted and device rebooted: index and Soroban peerstore preserved

## Lint

`npm run lint:apps -- dojo --check-images` — clean.
