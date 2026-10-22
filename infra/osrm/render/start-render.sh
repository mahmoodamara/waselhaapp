#!/usr/bin/env bash
set -euo pipefail
port=${PORT:-10000}
threads=${OSRM_THREADS:-1}
if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
  echo 'PORT must be an integer from 1 to 65535' >&2
  exit 1
fi
if [[ ! "$threads" =~ ^[1-9][0-9]?$ ]] || (( threads > 16 )); then
  echo 'OSRM_THREADS must be an integer from 1 to 16' >&2
  exit 1
fi
for suffix in properties partition cells cell_metrics mldgr; do
  [[ -s "/data/map.osrm.$suffix" ]] || { echo 'Prepared routing graph is missing; refusing to start' >&2; exit 1; }
done
# WARNING suppresses per-request URL/access logs, which can contain coordinates.
# OSRM 26.10 validates location limits as strictly greater than two.
# Three is the smallest supported cap; the existing backend requests two points.
exec osrm-routed --algorithm mld --ip 0.0.0.0 --port "$port" --threads "$threads" \
  --max-viaroute-size 3 --max-table-size 3 --max-trip-size 3 --max-matching-size 3 \
  --max-nearest-size 1 --max-nearest-locations 1 --max-alternatives 0 \
  --max-header-size 4096 --max-request-body-size 1024 --verbosity WARNING /data/map.osrm
