# Local self-hosted OSRM

For production on the backend host, use [the production runbook](../deploy/README.md)
and `scripts/setup-osrm.sh`. It reuses this pinned image and builds isolated,
route-checked releases without changing the running graph. This local compose
and its development data remain unchanged.

The pilot selects a project-controlled OSRM instance using OpenStreetMap data.
Google remains deferred; its local key is neither required nor used. No public
router is configured as a fallback. This setup was **run successfully on Windows
on 2026-10-09** using Docker Desktop/WSL2. See the
[STEP 5 final report](../../docs/step-5-osrm-final-report.md) for the exact source,
graph, route sample, anomaly review, live application checks and fresh regression.

The [official OSRM quick start](https://github.com/Project-OSRM/osrm-backend#quick-start)
recommends MLD for general routing. Use the unchanged `/opt/car.lua` profile:
extract -> partition -> customize -> routed. The compose file pins the official
[26.10.0 Debian image](https://github.com/Project-OSRM/osrm-backend/pkgs/container/osrm-backend)
by its multiarch digest, so preprocessing and serving use the same binary.

## Prerequisites and data

Docker Desktop with Linux containers (or an existing Linux Docker engine), Docker
Compose (`docker compose`), and enough RAM/free disk for the source **plus** generated graph and
container image. Do not install system software as part of these commands.
If the runtime is unavailable, stop before downloading/preprocessing.

Run the following **PowerShell** commands from the Waselha repository root.
Stop on any failed command; do not start serving partially prepared data.

```powershell
$ErrorActionPreference = 'Stop'
docker --version
if ($LASTEXITCODE -ne 0) { throw 'Docker unavailable' }
docker info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker daemon unavailable' }
docker compose version
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose unavailable' }

$taskCompose = Join-Path (Get-Location) 'infra/osrm/compose.yaml'
$taskDataDirectory = Join-Path (Get-Location) 'infra/osrm/data'
New-Item -ItemType Directory -Force -Path $taskDataDirectory | Out-Null
Get-PSDrive -Name (Get-Item $taskDataDirectory).PSDrive.Name | Select-Object Name,Free

$taskImage = docker compose -f $taskCompose config --images
if ($LASTEXITCODE -ne 0) { throw 'Invalid compose configuration' }
docker pull $taskImage
if ($LASTEXITCODE -ne 0) { throw 'OSRM image pull failed' }
docker run --rm $taskImage osrm-routed --version
if ($LASTEXITCODE -ne 0) { throw 'OSRM binary unavailable' }
```

Check that Docker reports `linux`. Confirm reasonable disk/RAM capacity before
continuing. Measure actual free space and generated size; no fixed dataset-to-graph
expansion estimate is assumed.

Use the public [Geofabrik Israel and Palestine extract](https://download.geofabrik.de/asia/israel-and-palestine.html),
which omits contributor personal metadata. The source and every generated file
stay in the ignored `data/` directory. Keep a single dataset snapshot for an entire
validation run; do not download again between preprocessing stages.

```powershell
$taskSource = 'https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf'
$taskPbf = Join-Path $taskDataDirectory 'israel-and-palestine-latest.osm.pbf'
Invoke-WebRequest -Uri $taskSource -OutFile $taskPbf -UseBasicParsing
$taskChecksumText = (Invoke-WebRequest -Uri ($taskSource + '.md5') -UseBasicParsing).Content
if ($taskChecksumText -notmatch '^\s*([a-fA-F0-9]{32})\b') { throw 'Invalid source checksum' }
$taskExpectedMd5 = $Matches[1].ToLowerInvariant()
$taskActualMd5 = (Get-FileHash -LiteralPath $taskPbf -Algorithm MD5).Hash.ToLowerInvariant()
if ($taskActualMd5 -ne $taskExpectedMd5) { throw 'Dataset checksum mismatch; stop and obtain a matching snapshot' }
Get-Item -LiteralPath $taskPbf | Select-Object Name,Length,LastWriteTimeUtc
[DateTime]::UtcNow.ToString('o')
```

Record the download UTC date, bytes, source checksum and the dataset's OSM timestamp
(from the Geofabrik page for that download or a PBF header inspector). Local file
mtime/download time is not the OSM snapshot date. MD5 checks download integrity;
HTTPS and the official source establish where the file was obtained.

## Preprocess, then start

```powershell
docker run --rm -v "${taskDataDirectory}:/data" $taskImage osrm-extract -p /opt/car.lua /data/israel-and-palestine-latest.osm.pbf
if ($LASTEXITCODE -ne 0) { throw 'osrm-extract failed' }
docker run --rm -v "${taskDataDirectory}:/data" $taskImage osrm-partition /data/israel-and-palestine-latest.osrm
if ($LASTEXITCODE -ne 0) { throw 'osrm-partition failed' }
docker run --rm -v "${taskDataDirectory}:/data" $taskImage osrm-customize /data/israel-and-palestine-latest.osrm
if ($LASTEXITCODE -ne 0) { throw 'osrm-customize failed' }
Get-ChildItem -LiteralPath $taskDataDirectory -File -Filter '*.osrm*' | Measure-Object -Property Length -Sum
docker compose -f $taskCompose up -d
if ($LASTEXITCODE -ne 0) { throw 'OSRM start failed' }
docker compose -f $taskCompose logs --tail 30 osrm
```

`.osrm` is a graph basename; there need not be a file with that exact name.
Serving mounts generated data read-only and publishes port 5000 only on loopback.
Do not rebuild/replace the graph while the routing container is using it. Stop
the container first; do not assume graphs work across different OSRM versions.

## Direct smoke and backend configuration

The following two points are **synthetic demo pins**, not claimed POIs or customer
homes. OSRM takes `longitude,latitude`. This smoke establishes connectivity and a
positive route only; it does not establish road accuracy or pilot readiness.

```powershell
$taskRouteUrl = 'http://127.0.0.1:5000/route/v1/driving/35.3398,32.7459;35.35,32.75?overview=false&steps=false&alternatives=false'
$taskWatch = [Diagnostics.Stopwatch]::StartNew()
$taskRouteHttp = Invoke-WebRequest -Uri $taskRouteUrl -UseBasicParsing -TimeoutSec 5
$taskWatch.Stop()
$taskRoute = $taskRouteHttp.Content | ConvertFrom-Json
$taskMeters = $taskRoute.routes[0].distance
if ($taskRouteHttp.StatusCode -ne 200 -or $taskRoute.code -ne 'Ok' -or
    ($taskMeters -isnot [int] -and $taskMeters -isnot [long] -and
     $taskMeters -isnot [double] -and $taskMeters -isnot [decimal]) -or
    [double]::IsNaN($taskMeters) -or [double]::IsInfinity($taskMeters) -or $taskMeters -le 0) {
  throw 'OSRM smoke failed'
}
[pscustomobject]@{ endpoint='local/self-hosted'; HTTP=$taskRouteHttp.StatusCode; code=$taskRoute.code; distanceMeters=$taskMeters; latencyMs=$taskWatch.ElapsedMilliseconds; status='PASS' }
```

For the backend process (or set only these routing entries in its local `.env`):

```powershell
$env:ROUTING_BASE_URL = 'http://127.0.0.1:5000'
$env:ROUTING_TIMEOUT_MS = '5000'
npm.cmd --prefix backend start
```

Use the existing backend adapter's normalization and price calculation. Do not
edit/delete any Google key or use it for this validation. Backend config defaults
still enable no router; these overrides explicitly select this local instance.

After smoke, execute 20-30 public/synthetic pilot routes, review snapping/detours
and every unexpected result, record per-case meters/latency/notes, then execute an
isolated test-order flow and destination A -> B recalculation through this instance.
See [STEP 5](../../docs/step-5-route-pricing.md) for the remaining validation gates.
Normal automated tests keep their local fake provider and require no Docker.

### Reproduce the opt-in live application validation

The probe uses a **new, empty, loopback MongoDB `*_test` database**; it refuses to
reset an existing populated fixture. It validates 26 predetermined public road
routes through the production adapter, then exercises real application HTTP,
MongoDB, price/split, destination changes, stale confirmation, pickup and recovery.
It pauses **only this compose project's running, loopback-bound OSRM container**
to cause a real 5000-ms timeout, and unpauses it in `finally`. Do not run the
failure probe while another operator is relying on this local instance.

```powershell
$env:RUN_LIVE_OSRM = '1'
$env:ROUTING_BASE_URL = 'http://127.0.0.1:5000'
$env:LIVE_OSRM_TEST_URI = 'mongodb://127.0.0.1:27017/waselha_live_' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '_test'
$env:OSRM_DOCKER_EXE = (Get-Command docker).Source
$env:OSRM_CONTAINER_ID = docker compose -f infra/osrm/compose.yaml ps -q osrm
node backend/test/live-osrm.mjs
if ($LASTEXITCODE -ne 0) { throw 'Live application validation failed' }
```

Public endpoint definitions and OSM node/way sources are in `pilot-points.json`.
The sample was selected across a geographic grid before observing routing
results. Raw per-route meters, latency, snap/detour screens, local geometry
inspection files and sanitized application results go to ignored
`.verification/step5-live/`; geometry is never added to application order records.
An automatic `problematic` screen requires individual review before closure.
The final report retains both such screens and the evidence explaining them.

For the optional Arabic/Hebrew browser check, set `$env:LIVE_OSRM_SERVE = '1'`
**before** the node command; it leaves the isolated app on `127.0.0.1:3106`
after successful API checks. In another terminal run
`python infra/osrm/live-browser.py` with Python Playwright and its Chromium
available. On this machine, the existing project verification package is loaded
using `$env:PYTHONPATH = (Resolve-Path .verification/python-playwright).Path`.
The current web production build must exist. The browser uses the live router;
only optional reverse labels and map tiles are fixtures. Stop the isolated app
after inspecting its output. `LIVE_OSRM_SERVE` is absent by default.

To reproduce the recorded detour review, save the public OSM API response from
`https://api.openstreetmap.org/api/0.6/map?bbox=35.315,32.725,35.36,32.77` to
`.verification/step5-live/kafr-kanna-review-osm.xml`, then run
`python infra/osrm/review-detour.py` after the live sample. It produces an
independent, approximate shortest-distance topology check and a credited SVG.
This review is not an application routing fallback and does not change the
official car profile. The exact OSM/Geofabrik snapshots remain local evidence;
later map updates may legitimately change results.

To stop only this compose service:

```powershell
docker compose -f $taskCompose down
```

This does not delete the dataset. No scheduled data refresh is installed. A later
operational refresh repeats preprocessing while stopped and records a new snapshot.
Permanent hosting/private backend connectivity is deferred to deployment work.

## Licence and attribution

OSRM is [BSD-2-Clause](https://github.com/Project-OSRM/osrm-backend/blob/master/LICENSE.TXT);
retain its notices/disclaimer when redistributing its software/binaries. OSM data
is [ODbL](https://www.openstreetmap.org/copyright). Preserve source notices and
attribution, including the licence link; distributing modified/derived databases
requires following the ODbL conditions. This directory's README is the data notice
for the local extract/graph. No Google data is added to the graph.

For public use of a Produced Work from a Derivative Database, ODbL section 4.6
also requires offering the database or its alterations/method in machine-readable
form. Retain the exact source snapshot and image/profile/preprocessing records
for that offer; an attribution label alone does not replace those obligations.

The [OSMF routing-engine guidance](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines#Routing_engines)
requires credit in applications incorporating OSM routing. Waselha retains map
attribution and links `© OpenStreetMap contributors` near route-derived results
in web Store/Customer/Admin and driver Current/Available views. No general legal
exemption for arbitrary derived databases or future export features is asserted.
