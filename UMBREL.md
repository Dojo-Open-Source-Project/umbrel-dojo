# Umbrel deltas

This repository vendors [Samourai Dojo](https://github.com/Dojo-Open-Source-Project/samourai-dojo)
so that Umbrel-ready container images can be built from a pinned, reviewable tree.

**Vendored upstream version:** `v1.29.3` — tag `3f59af3778be918f88f2659804e0e075e733b3a4`,
commit `8d5d03250841e371f779a7f9bfb812bdc4187797` (2026-09-02).

Everything outside the list below is byte-identical to that tag. Verify at any time with:

```sh
git fetch --no-tags https://github.com/Dojo-Open-Source-Project/samourai-dojo refs/tags/v1.29.3:refs/tags/v1.29.3
git diff v1.29.3 -- . ':!umbrel' ':!.github' ':!UMBREL.md' ':!README.md'
```

## Deltas against upstream

### 1. `docker/my-dojo/mysql/Dockerfile` — file modes `0440`/`0550` → `0444`/`0555`

Upstream tightened these modes in v1.29.3 ("Fixed permissions on mysql docker image files").
They assume the container runs as root or as a member of the `mysql` group.

Umbrel runs app containers as `user: "1000:1000"` (the UID that owns `${APP_DATA_DIR}`), which
is neither. With upstream's modes the entrypoint fails on first boot:

```
/usr/local/bin/docker-entrypoint.sh: line 88: /docker-entrypoint-initdb.d/1_db.sql: Permission denied
```

and the container exits 1 before the schema is created. Making the config, the init SQL and
`update-db.sh` world-readable/-executable fixes it. These files contain no secrets — they are the
public Dojo schema and a copy of a config file that is also in this repo.

Worth upstreaming.

### 2. `lib/auth/auth-rest-api.js` — guard `verifierSoroban` on the hostname

Upstream builds two auth47 verifiers. `verifier` is guarded on
`keys.auth.strategies?.auth47?.hostname`; `verifierSoroban`, three lines below,
is not. When Dojo has no onion address that second one evaluates
`new URL("/v2/auth/auth47/authenticate/soroban")` with no base, which throws:

```
TypeError: Invalid URL ... at new Auth47Verifier ... at lib/auth/auth-rest-api.js:45
```

It throws at module load, so the **Accounts process dies before it can listen**
on 8080. Nothing else in the app comes up behind it.

`keys/index.js` reads that onion from `/var/lib/tor/hsv3dojo/hostname`. In
MyDojo `/var/lib/tor` is a volume shared with Dojo's own Tor container, so the
file is always there and upstream never hits this. Under Umbrel the hidden
service lives in Umbrel's Tor data directory instead, so without the bind mount
the package now adds, the file is absent and Dojo will not start at all.

The guard restores what the code already expects: the request handler at line
287 checks `if (!verifierSoroban)` and answers "Auth47 not enabled", so a null
verifier is the anticipated state, not an error.

Definitely worth upstreaming.

### 3. `static/admin/lib/common-script.js` — transaction links for Mempool

`getExplorerTxUrl()` branched on the explorer type and returned `null` for
anything it did not recognise:

```js
else if (explorerInfo.type === 'explorer.btc_rpc_explorer')
    return `${explorerInfo.url}/tx/${txid}`
else
    return null
```

`explorer.mempool_space` is a type `keys.index.js` itself can produce, and it is
the one we configure (Umbrel's Mempool app — see `umbrel/dojo/hooks/pre-start`),
so every transaction link in the Maintenance Tool fell through to `null`.

That is worse than no link. All five call sites interpolate the result straight
into markup — `addresses-tools.js:155,183`, `txs-tools.js:75`,
`xpubs-tools.js:265,293` — so `null` renders as the literal `href="null"`, a
broken link on every transaction row in the wallet, address and transaction
tools.

Added the missing branch. Mempool uses the same `/tx/<txid>` path as BTC RPC
Explorer:

```js
else if (explorerInfo.type === 'explorer.mempool_space')
    return `${explorerInfo.url}/tx/${txid}`
```

Worth upstreaming: this is a gap in upstream's own supported set, not something
specific to our packaging.

Still unpatched, and pre-existing: when there genuinely is no explorer — stock
Dojo's default `{type: "explorer.null"}`, or ours before Mempool has published
its onion — the `href="null"` problem remains, because the callers never check
for null. Fixing it means touching all five call sites rather than one
function, which is a larger delta to re-apply on every upstream bump than the
cosmetic payoff justifies. The state is transient for us: Mempool is a required
dependency, so the steady state has an explorer.

### 4. `docker/my-dojo/node/keys.index.js` — guard the remaining hostname reads

This file is imported by every pm2 app, so anything it throws at module load
stops Dojo starting at all rather than disabling one feature. Upstream already
knows this: the `hsv3dojo` read and the `hsv3explorer` read are both wrapped in
try/catch. Two others are not.

```js
indexerUrl = `...${fs.readFileSync("/var/lib/tor/hsv3electrum/hostname", ...)}:50001`;   // INDEXER_INSTALL=on
sorobanExternalUrl = `http://${fs.readFileSync("/var/lib/tor/hsv3soroban/hostname", ...)}/rpc`;  // SOROBAN_ANNOUNCE=on
```

Both read a path that exists in MyDojo, where `/var/lib/tor` is a volume shared
with Dojo's own Tor container, and neither exists in the node container under
Umbrel unless the package mounts it.

**This shipped as a live bug.** `1.29.3-patch.9` exposed `SOROBAN_ANNOUNCE` as an
umbrelOS app setting; turning it on made all five processes die at import with
`ENOENT: /var/lib/tor/hsv3soroban/hostname`, and the app never listened on 8080.
The warning against `INDEXER_INSTALL` in section 6 below had described the
identical hazard for a year without anyone applying it to its neighbour.

The package now mounts `${APP_DATA_DIR}/data/soroban` at `/var/lib/tor/hsv3soroban`
and waits for the file before starting the node, so the read normally succeeds —
these guards are the backstop for a lost race, not the fix.

Kept local rather than upstreamed, by choice. Worth revisiting: it costs
upstream nothing and removes the same trap for every other packager.

### 5. Files upstream generates at install time

Upstream's `docker/my-dojo/install/install-scripts.sh` writes several gitignored files on the host
before `docker compose build` runs. We do not run `dojo.sh`, so `umbrel/scripts/prepare-build.sh`
makes the same choices, once, for both CI and local builds:

| File | Upstream source | Our choice |
|---|---|---|
| `docker/my-dojo/mysql/mysql-dojo.cnf` | `mysql-default.cnf` or `mysql-low_mem.cnf` | always `mysql-low_mem.cnf` — Umbrel targets Raspberry Pi 4/5 and similar 4–8 GB devices |
| `static/admin/conf/index.js` | `index-mainnet.js` or `index-testnet.js` | not generated; nginx serves the network-specific file instead, so the image stays network-agnostic (see `umbrel/images/nginx/`) |
| `docker/my-dojo/nginx/dojo.conf` | `mainnet.conf` or `testnet.conf` | not used; we build our own nginx image |

### 6. Things deliberately *not* patched

- `docker/my-dojo/node/keys.index.js` takes everything else from the environment —
  `BITCOIND_*`, `INDEXER_*`, `NET_DOJO_MYSQL_IPV4`, `NET_DOJO_SOROBAN_IPV4`,
  `NET_DOJO_TOR_IPV4` and the `NODE_*` settings — and needs no changes beyond the guards in
  delta 4.
- **Do not set `INDEXER_INSTALL=on`** in the Umbrel package. That branch reads
  `/var/lib/tor/hsv3electrum/hostname`, which only exists when Dojo runs its own bundled indexer
  behind its own Tor container. Delta 4 means it no longer takes Dojo down, but the indexer URL
  would be null and the setting pointless: Umbrel points Dojo at the `electrs` (or `fulcrum`) app
  instead, via `NODE_ACTIVE_INDEXER=local_indexer` + `INDEXER_IP`/`INDEXER_RPC_PORT`.
- `docker/my-dojo/dojo.sh`, `install/`, `overrides/`, and the bitcoind/explorer/indexer/fulcrum
  image definitions are kept as upstream ships them. Umbrel provides those services as separate
  apps, so we simply do not build or run them.

## Bumping to a new upstream version

```sh
git fetch --no-tags https://github.com/Dojo-Open-Source-Project/samourai-dojo refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
git rm -rq . && git checkout vX.Y.Z -- .        # restores our own files in the next step
git checkout HEAD@{1} -- umbrel .github UMBREL.md README.md
```

Then re-apply deltas 1, 2 and 4, re-read `RELEASES.md` for anything affecting the package (new env vars,
schema migrations, service topology), update the version tags in `umbrel/dojo/`, and rebuild.
