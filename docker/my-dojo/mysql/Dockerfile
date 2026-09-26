FROM    mariadb:12.1.2

ENV     MARIADB_AUTO_UPGRADE=true

# MariaDB must read this, but should not modify it.
# umbrel: world-readable (0444) instead of 0440 -- Umbrel runs this container
# as an arbitrary UID (1000:1000), which is neither root nor in the mysql group.
COPY    --chown=root:mysql --chmod=0444 \
        ./docker/my-dojo/mysql/mysql-dojo.cnf \
        /etc/mysql/conf.d/mysql-dojo.cnf

# Executable by root and the mysql group
# umbrel: world-executable (0555), see note above
COPY    --chown=root:mysql --chmod=0555 \
        ./docker/my-dojo/mysql/update-db.sh \
        /update-db.sh

# MariaDB initialization scripts only need to be readable
# umbrel: world-readable (0444), see note above
COPY    --chown=root:mysql --chmod=0444 \
        ./db-scripts/*.sql \
        /docker-entrypoint-initdb.d/
