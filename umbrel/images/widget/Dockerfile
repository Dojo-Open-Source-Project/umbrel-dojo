# The home-screen widget server. See server.mjs for what it does and why it is
# its own container.
#
# Same base as the Dojo node image (docker/my-dojo/node/Dockerfile) so a device
# running this app pulls one Node base layer rather than two.
FROM node:24-alpine3.23

# No package.json and no npm install: the server uses nothing but node:http and
# the global fetch, so there is no lockfile to keep current and no dependency
# surface to audit.
COPY --chmod=0444 server.mjs /server.mjs

# Umbrel runs app containers as an unprivileged user; nothing here writes to
# disk, so there is no state to own.
USER 1000:1000

EXPOSE 3000

CMD ["node", "/server.mjs"]
