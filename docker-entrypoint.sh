#!/bin/sh
# Hosts mount the data volume owned by root; hand it to the node user, then
# run the server as node. exec keeps node as PID 1 so SIGTERM reaches it.
set -e
if [ "$(id -u)" = 0 ]; then
  mkdir -p /data
  chown -R node:node /data
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
