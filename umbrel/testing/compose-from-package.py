#!/usr/bin/env python3
"""Build a runnable compose file from the App Store package.

The service definitions are taken verbatim from the package's docker-compose.yml
so the smoke test exercises what Umbrel would actually run. Only the things
umbrelOS itself supplies are added here:

  - container names (umbrelOS injects `<app-id>_<service>_1`)
  - the app_proxy service is dropped; umbrelOS generates it, and the test hits
    the Connect UI on its published port instead
  - a regtest bitcoind standing in for Umbrel's Bitcoin Node app
  - ports published to the host so the test can reach the app

There is no electrs stand-in. Dojo only talks to the indexer for xpub imports
and rescans, which need a real chain; the rest of the app does not depend on
it. That gap is the main thing this harness cannot cover.
"""
import pathlib
import sys

import yaml

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_PACKAGE = HERE.parent / "dojo"


def main(out_path: str, data_dir: str, package_dir: str = None) -> None:
    package = pathlib.Path(package_dir) if package_dir else DEFAULT_PACKAGE

    # The app id and the browser port come from the manifest, so this works
    # unchanged against the community-store variant, where the id carries the
    # store prefix and every injected container name moves with it.
    manifest = yaml.safe_load((package / "umbrel-app.yml").read_text())
    app_id = manifest["id"]
    proxy_port = manifest["port"]

    pkg = yaml.safe_load((package / "docker-compose.yml").read_text())
    services = pkg["services"]

    services.pop("app_proxy", None)
    for name, service in services.items():
        service["container_name"] = f"{app_id}_{name}_1"

    # Reach the app from the host.
    services["nginx"].setdefault("ports", []).append(f"{proxy_port}:8081")

    # The widget endpoint. umbrelOS reaches it over the app network, so the
    # package publishes nothing; the test has no app network to sit on, so it
    # publishes one well clear of the manifest port and the API port beside it
    # -- and clear of the community-store variant's pair too, which sit two
    # above the official one's.
    widget_port = proxy_port + 100
    services["widget"].setdefault("ports", []).append(f"{widget_port}:3000")

    services["bitcoind"] = {
        "image": "bitcoin/bitcoin:29.0",
        "container_name": f"{app_id}_bitcoind_1",
        "restart": "on-failure",
        # No `user:` here. This stands in for Umbrel's Bitcoin Node app, and
        # the official Core image needs a root entrypoint (it runs usermod
        # before dropping privileges). The 1000:1000 rule applies to this
        # package's own containers, which is what the test is checking.
        "command": [
            "-regtest",
            "-server=1",
            "-txindex=1",
            "-fallbackfee=0.0002",
            "-rpcbind=0.0.0.0",
            "-rpcallowip=10.21.0.0/16",
            "-rpcport=8332",
            "-rpcuser=umbrel",
            "-rpcpassword=testpassword",
            "-zmqpubrawtx=tcp://0.0.0.0:28333",
            "-zmqpubhashblock=tcp://0.0.0.0:28334",
            "-datadir=/data/.bitcoin",
        ],
        "volumes": [f"{data_dir}/bitcoin:/data/.bitcoin"],
        "networks": {"default": {"ipv4_address": "10.21.21.8"}},
    }

    # umbrelOS injects its own shared network; the package deliberately has no
    # top-level networks block, so the test supplies one with the same subnet
    # the static IPs in exports.sh assume.
    pkg["networks"] = {
        "default": {
            "driver": "bridge",
            "ipam": {"config": [{"subnet": "10.21.0.0/16"}]},
        }
    }

    pathlib.Path(out_path).write_text(yaml.dump(pkg, sort_keys=False, width=10**6))


if __name__ == "__main__":
    main(*sys.argv[1:])
