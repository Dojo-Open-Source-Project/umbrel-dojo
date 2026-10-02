# nginx for the Umbrel Dojo app: serves the Dojo API on 8080 and the Connect
# UI (the page Umbrel's app_proxy opens) on 8081.
#
# The configs and the Connect UI live in the image rather than in bind mounts
# because Umbrel only copies docker-compose.yml, top-level *.template files,
# exports.sh, torrc and hooks/ into an installed app on update -- anything
# bind-mounted from the package directory would stay frozen at whatever the
# user first installed.
FROM nginx:1.29.4-alpine

# Config. The per-network site config is selected at start time by the
# entrypoint, so one image serves mainnet and testnet.
COPY nginx.conf /etc/nginx/nginx.conf
COPY conf.d/ /etc/nginx/available/

# Connect UI
COPY connect/ /var/www/connect/

# Stamp a content hash into the asset URLs whose filenames never change.
#
# Without this, a browser holding style.css or app.js from a previous image
# pairs them with a freshly fetched index.html -- and an old app.js against new
# markup throws on the first element that no longer exists, aborting before the
# page ever logs in. The result is not an ugly page but a dead one: no status,
# no pairing. That shipped in 1.29.3-patch.4.
#
# A hash of the file's own contents means a changed file is a new URL, so the
# browser cannot serve a stale one against new markup -- and because index.html
# is revalidated on navigation, this also rescues anyone already holding a bad
# cache. conf.js is deliberately absent: it is generated per container at
# startup, so its hash is not knowable here, and Cache-Control in connect.conf
# is what keeps it fresh.
RUN set -eux; \
    cd /var/www/connect; \
    for asset in css/style.css js/app.js js/qrcode.min.js; do \
        hash="$(md5sum "$asset" | cut -c1-10)"; \
        sed -i "s|\"${asset}\"|\"${asset}?v=${hash}\"|g" index.html; \
    done; \
    # Fail the build rather than ship an unstamped page if the markup's
    # reference shape ever changes and the substitutions silently no-op.
    grep -q 'css/style.css?v=' index.html; \
    grep -q 'js/app.js?v=' index.html

# wait-for, from upstream Dojo (docker/my-dojo/nginx/wait-for)
COPY --chmod=0555 wait-for /wait-for

COPY --chmod=0555 entrypoint.sh /entrypoint.sh

RUN set -eux; \
    mkdir -p /etc/nginx/sites-enabled; \
    # Writable by any UID: Umbrel runs app containers as an unprivileged user
    # that is not in the nginx group.
    chmod 0777 /etc/nginx/sites-enabled /var/www/connect/js

EXPOSE 8080 8081

ENTRYPOINT ["/entrypoint.sh"]
