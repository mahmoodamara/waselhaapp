#!/usr/bin/env bash
# Build an immutable candidate; activation is a separate compose operation.
set -euo pipefail
umask 022
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ $# != 2 ]]; then
  echo "Usage: OSRM_DATA_DIR=/opt/waselha/osrm-data bash scripts/setup-osrm.sh /absolute/map.osm.pbf RELEASE" >&2
  exit 1
fi
source_pbf=$1
release=$2
[[ -s "$source_pbf" && "$source_pbf" == *.osm.pbf ]] || { echo 'A nonempty .osm.pbf file is required' >&2; exit 1; }
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || { echo 'Invalid release name' >&2; exit 1; }
data=${OSRM_DATA_DIR:-/opt/waselha/osrm-data}
mkdir -p -- "$data/releases"
data=$(cd -- "$data" && pwd)
final="$data/releases/$release"
[[ ! -e "$final" ]] || { echo 'Release already exists; choose a new name. Existing data was not changed.' >&2; exit 1; }
mkdir -- "$data/.setup-lock" || { echo 'Another build is running (or a stale .setup-lock needs inspection)' >&2; exit 1; }
candidate=''
stage="$data/.build-$release-$$"
cleanup() {
  if [[ -n "$candidate" ]]; then docker rm -f "$candidate" >/dev/null 2>&1 || true; fi
  rmdir -- "$data/.setup-lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker info >/dev/null
# Serving and preprocessing always use the existing compose's exact image.
image=$(docker compose -f "$repo/infra/osrm/compose.yaml" config --images)
[[ -n "$image" && "$image" != *$'\n'* ]] || { echo 'Expected one OSRM image' >&2; exit 1; }
docker pull "$image"
mkdir -- "$stage"
map=israel-and-palestine-latest
echo "Preparing release $release in a separate build directory; active data is untouched."
cp -- "$source_pbf" "$stage/$map.osm.pbf"
# Git Bash is supported for local verification; production uses ordinary Linux paths.
docker_path() { if command -v cygpath >/dev/null; then cygpath -am "$1"; else printf '%s' "$1"; fi; }
export MSYS_NO_PATHCONV=1
mount="type=bind,source=$(docker_path "$stage"),target=/data"
common=(--rm --network none --cap-drop ALL --security-opt no-new-privileges:true --user "$(id -u):$(id -g)" --mount "$mount")
docker run "${common[@]}" "$image" osrm-extract -p /opt/car.lua "/data/$map.osm.pbf"
docker run "${common[@]}" "$image" osrm-partition "/data/$map.osrm"
docker run "${common[@]}" "$image" osrm-customize "/data/$map.osrm"
# OSRM creates fileIndex with owner-only permissions, independently of umask.
# Grant read access to graph artifacts so the unprivileged runtime UID can map
# them. The bind mount remains read-only; these contain public OSM data only.
docker run "${common[@]}" "$image" sh -c 'chmod 0444 /data/*.osrm*'
for suffix in partition cells cell_metrics mldgr properties; do
  [[ -s "$stage/$map.osrm.$suffix" ]] || { echo "Missing generated $suffix file; candidate not activated" >&2; exit 1; }
done
printf 'image=%s\nprofile=/opt/car.lua\nalgorithm=mld\nbuilt_utc=%s\n' "$image" "$(date -u +%FT%TZ)" > "$stage/build-info.txt"
(cd -- "$stage" && sha256sum "$map.osm.pbf") >> "$stage/build-info.txt"
# Test loading and a real route with the same least-privilege runtime. No ports
# are published and the running OSRM service is never stopped during this build.
candidate=$(docker run -d --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 \
  --mount "$mount,readonly" \
  --mount "type=bind,source=$(docker_path "$repo/infra/osrm/healthcheck.sh"),target=/healthcheck.sh,readonly" \
  "$image" osrm-routed --algorithm mld "/data/$map.osrm")
healthy=false
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$candidate" timeout 5 bash /healthcheck.sh >/dev/null 2>&1; then healthy=true; break; fi
  [[ $(docker inspect -f '{{.State.Running}}' "$candidate") == true ]] || break
  sleep 1
done
if [[ "$healthy" != true ]]; then
  docker logs --tail 15 "$candidate" >&2
  echo "Candidate failed its route check. Active release is unchanged; inspect $stage" >&2
  exit 1
fi
docker rm -f "$candidate" >/dev/null
candidate=''
# Move within the same filesystem only after every build and route check passed.
mv -- "$stage" "$final"
echo "READY: $final"
echo "Set OSRM_RELEASE=$release in the production compose env, then recreate only osrm. Retain the previous release for rollback."
