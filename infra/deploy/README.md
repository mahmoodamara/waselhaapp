# Redis + OSRM on the backend host

The current backend runs as a host Node.js process, behind the existing nginx
configuration. Use **only** `docker-compose.production.yml` for its dependencies;
the two local compose files remain development tools. Backend addresses are
`127.0.0.1:6379` and `127.0.0.1:5000`. No backend Docker migration or URL-validation
exception is needed. Never proxy Redis or OSRM through nginx.

## First-time setup (Linux, repository root)

1. Install a supported Docker Engine and Compose plugin using the
   [official installation instructions](https://docs.docker.com/engine/install/).
   Use Engine **28 or newer** (older engines had a loopback publication issue)
   and Compose **2.24.4 or newer** (also needed by the optional test fixture).
   Verify `docker info` reports Linux and `docker compose version` works.
   Enable Docker at boot: `sudo systemctl enable --now docker`.
   Supervise the existing backend separately with systemd/PM2 and enable its
   restart at boot. Redis and OSRM use `restart: unless-stopped`; a deliberately
   stopped service stays stopped until started by the operator.
2. Prepare private configuration and public map directories:

   ```bash
   sudo install -d -m 700 /etc/waselha
   sudo install -d -m 755 -o "$(id -u)" -g "$(id -g)" /opt/waselha/osrm-data
   sudo install -m 600 infra/deploy/.env.production.example /etc/waselha/infra.env
   # Set REDIS_PASSWORD in that file using a secret manager or openssl rand -hex 32.
   # It must be exactly 64 random hex characters; no default is accepted.
   ```

   Keep this file outside Git. Run the compose commands below as an operator who
   can read it and access Docker. Docker access itself grants host-level authority.
   Do not print `docker compose config`, raw `docker inspect`, the backend
   environment or shell traces: they can contain environment secrets.
3. Use the existing Israel/Palestine source if current enough, or download a
   new snapshot outside Git. The public road sample and current service area
   are Kafr Kanna. Allow space for the old release, PBF and new graph together;
   measure resource needs on the target host.

   ```bash
   mkdir -p /opt/waselha/osrm-data/incoming
   cd /opt/waselha/osrm-data/incoming
   curl --fail --location --proto '=https' -o israel-and-palestine-latest.osm.pbf.part \
     https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf
   curl --fail --location --proto '=https' -o source.md5 \
     https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf.md5
   expected=$(awk '{print $1}' source.md5)
   actual=$(md5sum israel-and-palestine-latest.osm.pbf.part | awk '{print $1}')
   test "$actual" = "$expected" || { echo 'Checksum mismatch: stop'; exit 1; }
   mv israel-and-palestine-latest.osm.pbf.part israel-and-palestine-latest.osm.pbf
   cd - # return to repository root
   ```

   Record the source's OSM snapshot time (not just download time), checksum and
   source URL from [Geofabrik](https://download.geofabrik.de/asia/israel-and-palestine.html).
   A changing `latest` file/checksum pair may require downloading a matching pair again.
4. Preprocess separately from startup (Bash is required):

   ```bash
   OSRM_DATA_DIR=/opt/waselha/osrm-data bash scripts/setup-osrm.sh \
     /opt/waselha/osrm-data/incoming/israel-and-palestine-latest.osm.pbf map-20261022
   ```

   The script copies the source into a fresh build directory, runs the pinned
   official OSRM image with `/opt/car.lua`: extract → partition → customize,
   makes generated graph files readable by runtime UID 65534, then tests loading
   and a real route in an isolated container. It publishes a release directory
   **only after success**. A failure preserves the active release and leaves the
   failed build for inspection. Processing never runs when services start.
   Set `OSRM_RELEASE=map-20261022` in `/etc/waselha/infra.env` after success.
   The script reads the image from the existing OSRM compose so build/serve
   versions cannot drift. `build-info.txt` records image, profile, timestamp and
   source SHA256. Retain the original PBF and OSM attribution/license notices;
   see [OSRM data and licensing](../osrm/README.md#licence-and-attribution).
5. Set the backend's protected environment using its supervisor/secret store:

   ```text
   NODE_ENV=production
   HOST=127.0.0.1
   REDIS_URL=redis://:<same-64-hex-password>@127.0.0.1:6379
   ROUTING_BASE_URL=http://127.0.0.1:5000
   ROUTING_TIMEOUT_MS=30000
   ```

   Preserve all other existing settings from `backend/.env.production.example`,
   including MongoDB credentials, JWT secret and the real HTTPS public origin.
   Protected backend modes intentionally **do not load** `backend/.env`.
   `REDIS_PASSWORD` is a compose input; the backend uses `REDIS_URL` only.
   If a password ever contains URL-reserved characters, percent-encode it in
   the URL; this deployment requires hex to avoid that ambiguity.

## Operations

From the repository root, define this function in the operator's shell:

```bash
dc() { docker compose --env-file /etc/waselha/infra.env -f docker-compose.production.yml "$@"; }
dc config --quiet                  # validates without dumping interpolated secrets
dc up -d --wait --wait-timeout 120
dc ps
dc logs --tail 50 redis
dc logs --tail 50 osrm
dc restart redis
dc restart osrm
dc down                           # volumes and map directories are retained
dc up -d --wait --wait-timeout 120
```

Start/restart the backend with its existing supervisor after the initial setup.
Later dependency restarts should recover using the backend's existing Redis
reconnect logic and per-request OSRM client. No backend restart is required for
normal dependency recovery. `unless-stopped` handles process/host restarts;
healthcheck failures report unhealthy status but do not themselves restart Docker.

Redis uses a named volume, AOF `everysec` (up to about one second of acknowledged
writes can be lost in a crash), no snapshots and `noeviction`. MongoDB remains
the durable business store. Redis stores expiring live state, not GPS history;
AOF may retain expired bytes until rewrite. Restrict host/volume/backup access and
monitor memory, disk, AOF rewrites and failed writes. The initial 128 MB Redis
limit preserves the development capacity choice; tune using measured load.
Never run `down -v` against production. Containers run without capabilities,
with read-only roots and rotated logs; only Redis `/data` and its private tmpfs
configuration are writable. Authentication follows the
[Redis security model](https://redis.io/docs/latest/operate/oss_and_stack/management/security/).

## Verify on the actual server

```bash
dc exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw ping'
# PONG (credential stays out of command arguments/output)
dc exec -T redis redis-cli ping
# NOAUTH Authentication required
dc exec -T osrm timeout 5 bash /usr/local/bin/healthcheck-osrm.sh
curl --fail 'http://127.0.0.1:5000/route/v1/driving/35.3357268,32.7486911;35.3437821,32.7356136?overview=false'
curl --fail http://127.0.0.1:3000/api/ready
```

Check `code=Ok`, numeric `distance` and `duration` in routes. More public road
pairs: `35.3268524,32.7370844;35.3357268,32.7486911` and
`35.3437821,32.7356136;35.3508228,32.7475921`.
Use a designated test account/order through the backend and verify a final
OSRM price. Repeat after each restart and after `down`/`up` in a maintenance
window. `/api/health` is liveness; `/api/ready` reports Redis failure as 503.
Routing health is informational (`ok`/`unreachable`, cached for 30 seconds) and
does not make the entire app unready; this existing business behavior is preserved.

Verify `ss -lnt` and `docker compose ... port redis 6379` / `port osrm 5000`
show loopback only. From a **different external machine**, connections to the
server's IPv4 and IPv6 on 6379/5000 must fail. Do not add firewall allowances for
them; only nginx HTTPS is public. Loopback services remain reachable to trusted
host processes and administrators; this is a single trusted backend host setup.

## Safe map update and rollback

Download and verify a new PBF under `incoming/`, then run `setup-osrm.sh` with a
**new** release name. Do not overwrite a running release or build into its mount.
Retain the previous `OSRM_RELEASE` value. After the candidate passes, change that
value in `infra.env`, then:

```bash
dc up -d --no-deps --force-recreate --wait --wait-timeout 120 osrm
# Repeat route and backend checks above.
```

Switching a single OSRM instance creates brief routing downtime. On failure,
restore the previous release value and run the same recreate command; verify
readiness and routes again. Merely using `restart` does not apply a changed bind
mount. Keep at least the previous tested release until acceptance. After an
interrupted build, inspect `.build-*` and `.setup-lock`; remove the lock only
after confirming no build is running. Cleanup of obsolete data is manual.

## Reproducible local checks

Configuration unit checks: `node --test backend/test/production-infra.mjs`.
The opt-in integration fixture creates its own compose project and Redis volume,
uses alternate ports 16379/15000 and a random empty local MongoDB `*_test` DB,
and removes **only its own** containers/volume/database on exit. Existing
development services remain running. It tests authentication, AOF, expiry,
loopback bindings, real routes through the adapter and HTTP order pricing,
readiness, dependency restarts and `down`/`up` without restarting the backend.

```bash
OSRM_DATA_DIR="$PWD/.verification/production-infra/osrm-data" bash scripts/setup-osrm.sh \
  "$PWD/infra/osrm/data/israel-and-palestine-latest.osm.pbf" local-test-1
RUN_PRODUCTION_INFRA_TEST=1 OSRM_RELEASE=local-test-1 \
  LIVE_INFRA_OSRM_DATA_DIR="$PWD/.verification/production-infra/osrm-data" \
  LIVE_INFRA_MONGODB_URI=mongodb://127.0.0.1:27017/ \
  node backend/test/production-deps-live.mjs
```

Git Bash on Windows can run the preparation script; set the fixture's environment
variables in PowerShell if running Node there. The fixture deliberately never
reads real production credentials or deploys to a remote server. Local results
do not prove target-server firewall, reboot recovery, secrets or sizing.
