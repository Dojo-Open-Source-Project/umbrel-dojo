# Dojo OSP community app store

umbrelOS lets you add any GitHub repository as an extra app store, so the Dojo
package can be installed before the official
[umbrel-apps](https://github.com/getumbrel/umbrel-apps) submission lands.

**This repository is not itself a store.** A community store needs
`umbrel-app-store.yml` at its root and the app directory at the root too, and
this repository's root is the vendored Dojo source. The store is generated into
a separate repository instead:

Clone the store repository somewhere that persists, generate straight into it,
and push:

```sh
git clone https://github.com/Dojo-Open-Source-Project/umbrel-dojo-osp-store.git ~/umbrel-dojo-osp-store

./umbrel/scripts/make-community-store.py ~/umbrel-dojo-osp-store

cd ~/umbrel-dojo-osp-store
git add -A
git commit -m "Dojo OSP: <what changed>"
git push
```

The generator clears the tree it writes into but leaves `.git` alone, so the
same clone is reusable for every update.

**Do not keep that clone under `/tmp`.** The default output path is
`$TMPDIR/umbrel-dojo-osp-store`, which is fine for a one-shot look at the
generated tree, but `/tmp` is cleared on reboot — and when it goes it takes
`.git` with it, so the next push fails with *"not a git repository"* and has to
be re-cloned. Pass a path under your home directory, as above.

Then add the repository's URL in umbrelOS under **Settings → App Store →
Community App Stores**: `https://github.com/Dojo-Open-Source-Project/umbrel-dojo-osp-store`.

The store used to live at `linkinparkrulz/umbrel-dojo-osp-store`. GitHub
redirects that URL, so a device that added the old one keeps receiving updates.
New installs should use the address above.

## Making an update reach installed devices

umbrelOS decides an app has an update by comparing the manifest `version`
string and nothing else — new image digests in `docker-compose.yml` are
invisible to it. Any change to `version` in `umbrel/dojo/umbrel-app.yml`
counts, since the comparison is string inequality rather than semver ordering;
bump the `-patch.N` suffix. The device re-reads the store every five minutes.

## Why the app is called `dojo-osp-dojo`

A community store's `id` has to prefix every app id in it, so the app cannot be
plain `dojo`. The store is `dojo-osp` and the app is `dojo-osp-dojo`.

This is not just a label: umbrelOS derives container names from the app id as
`<app-id>_<service>_1`, so every hardcoded container name in the compose file
moves with it. `make-community-store.py` does that rewrite and asserts on each
substitution, so a service rename in the package fails the generator rather than
producing a store that installs and then cannot talk to itself.

## Differences from the official package

Generated, never hand-edited:

| | Official | Community |
|---|---|---|
| App id | `dojo` | `dojo-osp-dojo` |
| App port | 3023 | 3025 |
| Dojo API port | 3024 | 3026 |
| nginx IP | 10.21.21.31 | 10.21.21.32 |

The ports and IP move so both can be installed on the same device — useful for
comparing against the official app once it ships.

## Data does not carry over

umbrelOS treats them as different apps. A different app id means a different
`${APP_DATA_DIR}` and different `derive_entropy` secrets, so installing the
official app later gives you an empty Dojo with a new admin key and a new Tor
address. The index rebuilds and wallets have to be re-paired.

If you plan to move across, do it deliberately rather than expecting an upgrade.

## Testing it

The smoke test runs against either package:

```sh
PACKAGE_DIR=/tmp/umbrel-dojo-osp-store/dojo-osp-dojo ./umbrel/testing/smoke-test.sh
```

That is worth doing after regenerating, because it is what proves the renamed
container names still resolve to each other.
