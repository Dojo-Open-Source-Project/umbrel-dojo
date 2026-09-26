#!/usr/bin/env bash
#
# Generate the files that upstream's dojo.sh install/upgrade scripts normally
# create on the host before `docker compose build` runs.
#
# Upstream keeps these paths in .gitignore because they are per-install choices
# (docker/my-dojo/install/install-scripts.sh). We build images instead of
# running dojo.sh, so we make the same choices here, once, for both CI and
# local builds.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MY_DOJO="${REPO_ROOT}/docker/my-dojo"

# MariaDB config. Umbrel runs on Raspberry Pi 4/5 and similar 4-8 GB devices,
# so we always take upstream's low-memory profile rather than the default one.
cp "${MY_DOJO}/mysql/mysql-low_mem.cnf" "${MY_DOJO}/mysql/mysql-dojo.cnf"
echo "prepared: docker/my-dojo/mysql/mysql-dojo.cnf (from mysql-low_mem.cnf)"

# The Dojo Maintenance Tool loads its config from /admin/conf/index.js.
# Upstream's installer copies the network-specific file into place at install
# time, which would bake a network choice into the image. We serve it from
# nginx instead (see umbrel/images/nginx/dojo-*.conf), so nothing to do here.
