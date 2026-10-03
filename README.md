# umbrel-dojo

Umbrel App Store packaging for [Samourai Dojo](https://github.com/Dojo-Open-Source-Project/samourai-dojo),
the private backing server maintained by the Dojo Open Source Project.

This repository holds two things:

1. **Upstream Dojo, vendored at a pinned tag** (currently `v1.29.3`), so the container images can be
   built from a tree anyone can diff against upstream. See [UMBREL.md](./UMBREL.md) for every delta
   and how to bump to a new upstream version.
2. **The Umbrel app package** in [`umbrel/dojo/`](./umbrel/dojo), ready to drop into
   [getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps) as `dojo/`.

Dojo upstream publishes no container images — its own `docker-compose.yaml` uses `pull_policy: never`
and builds everything locally through `dojo.sh`. Umbrel needs prebuilt, publicly pullable, multi-arch
images, so this repository builds and publishes them.

## Images

All five are published to GHCR as multi-arch manifest lists (`linux/amd64` + `linux/arm64`):

| Image | Built from | Version source |
|---|---|---|
| `ghcr.io/linkinparkrulz/dojo-nodejs` | `docker/my-dojo/node/Dockerfile` (upstream) | `DOJO_NODEJS_VERSION_TAG` |
| `ghcr.io/linkinparkrulz/dojo-db` | `docker/my-dojo/mysql/Dockerfile` (upstream, one permission delta) | `DOJO_DB_VERSION_TAG` |
| `ghcr.io/linkinparkrulz/dojo-soroban` | `docker/my-dojo/soroban/Dockerfile` (upstream) | `DOJO_SOROBAN_VERSION_TAG` |
| `ghcr.io/linkinparkrulz/dojo-nginx` | [`umbrel/images/nginx/`](./umbrel/images/nginx) (ours) | `DOJO_VERSION_TAG` |
| `ghcr.io/linkinparkrulz/dojo-widget` | [`umbrel/images/widget/`](./umbrel/images/widget) (ours) | `DOJO_VERSION_TAG` |

Versions come from the vendored `docker/my-dojo/.env`, so they cannot drift from the source being built.

The nginx image is ours because the app needs two things upstream's does not provide: the Connect page
that Umbrel opens, and a config that survives app updates. Umbrel only copies `docker-compose.yml`,
top-level `*.template` files, `exports.sh`, `torrc` and `hooks/` into an installed app on update, so
anything bind-mounted out of the package directory stays frozen at whatever the user first installed.
Putting it in a pinned image means a digest bump delivers it like any other code change.

## Cutting a release

Release tags are `v<dojo version>-umbrel<n>` — the upstream Dojo version, then the packaging revision.
Bump `n` for a packaging-only change; the Dojo version follows upstream.

```sh
git tag v1.29.3-umbrel1
git push origin v1.29.3-umbrel1
```

The **Build images** workflow then builds each architecture on a native runner, pushes by digest, and
stitches the digests into one manifest list per image. Each image's full pinned reference and its
platforms are printed to the run summary:

```
ghcr.io/linkinparkrulz/dojo-db:1.7.0-umbrel1@sha256:...
```

Paste those four references into `umbrel/dojo/docker-compose.yml`, replacing the placeholder digests,
then verify:

```sh
docker buildx imagetools inspect ghcr.io/linkinparkrulz/dojo-db:1.7.0-umbrel1
```

Both `linux/amd64` and `linux/arm64` must be listed, and the package must be public in the repository's
package settings — Umbrel pulls without credentials.

> Native `ubuntu-24.04-arm` runners are free for public repositories. On a private repository the arm64
> matrix leg will not schedule; fall back to `docker/setup-qemu-action` and a single `platforms:
> linux/amd64,linux/arm64` build, and expect the Soroban build to take a long time.

## Working on the package

```sh
# Lint exactly as the App Store does
git clone --depth 1 https://github.com/getumbrel/umbrel-apps /tmp/umbrel-apps
cp -r umbrel/dojo /tmp/umbrel-apps/dojo
cd /tmp/umbrel-apps && npm install && npm run lint:apps -- dojo --check-images
```

The **Validate** workflow runs that on every push, and also re-fetches the upstream tag `UMBREL.md`
declares and reports any file in the vendored tree that differs from it.

To build an image locally, first generate the files upstream's installer would have written:

```sh
./umbrel/scripts/prepare-build.sh
docker build -f docker/my-dojo/mysql/Dockerfile -t dojo-db:local .
```

## What the app runs

| Service | Purpose |
|---|---|
| `node` | Dojo itself: accounts API, PushTx, tracker, fee estimator |
| `db` | MariaDB, holding the address and transaction index |
| `nginx` | The Dojo API on 8080 (Tor + LAN) and the Connect UI on 8081 (Umbrel's app proxy) |
| `soroban` | Soroban P2P node, so PandoTx can relay outgoing transactions through someone else's node |
| `tor` | Hidden service for the Dojo API |

Bitcoin Core and the Electrum server are **not** bundled: the app depends on Umbrel's Bitcoin Node and
Electrs apps, and Fulcrum can stand in for Electrs since it declares `implements: electrs`.

Whirlpool is not included. Its coordinator was shut down in 2024.

## Upstream

Dojo is developed at
[Dojo-Open-Source-Project/samourai-dojo](https://github.com/Dojo-Open-Source-Project/samourai-dojo)
and licensed AGPL-3.0-only. Bugs in Dojo itself belong upstream; this tracker is for packaging.
