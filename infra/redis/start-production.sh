#!/bin/sh
set -eu
# A URL-safe, high-entropy credential avoids config/URL escaping mistakes. Never
# put the password in process arguments, output or a persistent configuration.
case "${REDIS_PASSWORD:-}" in
  ''|*[!a-fA-F0-9]*) echo 'REDIS_PASSWORD must be 64 random hexadecimal characters' >&2; exit 1 ;;
esac
if [ "${#REDIS_PASSWORD}" -ne 64 ]; then
  echo 'REDIS_PASSWORD must be 64 random hexadecimal characters' >&2
  exit 1
fi
umask 077
cat > /tmp/redis-production.conf <<EOF
bind 0.0.0.0
protected-mode yes
port 6379
dir /data
save ""
appendonly yes
appendfsync everysec
maxmemory 128mb
maxmemory-policy noeviction
requirepass $REDIS_PASSWORD
EOF
exec redis-server /tmp/redis-production.conf
