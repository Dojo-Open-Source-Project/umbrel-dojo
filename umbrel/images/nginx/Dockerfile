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
