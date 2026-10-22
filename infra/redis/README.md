# Local realtime Redis

For the host-run production deployment (authentication, AOF, durable volume and
automatic restart), use [the production runbook](../deploy/README.md). This local
compose remains unchanged and is for development only.

Redis holds only expiring Phase 3 state. MongoDB remains the permanent store.

If Redis/Memurai is already available on loopback port 6379, use it via backend
`REDIS_URL`; do not start another service on that port. Otherwise, from the repo root:

```powershell
docker compose -f infra/redis/compose.yaml up -d
```

The example binds only `127.0.0.1:6379`, has no persistent volume, and disables
snapshot/AOF persistence. It is local development configuration, without credentials.
`noeviction` prevents memory pressure silently discarding live ordering watermarks;
if capacity is exhausted, writes fail closed and Redis must be provisioned appropriately.

Backend defaults: location TTL 90s, presence TTL 45s, freshness 15s. Override with
`LOCATION_TTL_SECONDS`, `PRESENCE_TTL_SECONDS`, `LOCATION_FRESH_MS` and `REDIS_URL`.
The phone receives no Redis credentials and connects only to the authenticated API origin.

For a future host, provide private authenticated Redis, TLS for remote connections
(`rediss://`), synchronized clocks and process supervision. Supply `REDIS_URL` through
host secrets. Deploy the repo's `shared/` directory alongside backend. Proxy `/socket.io/`
to the same HTTP server with WebSocket Upgrade/Connection headers and a timeout greater
than the Socket.IO heartbeat window; the nginx example uses 75s. Multi-instance operation
requires a separate review and is outside Phase 3. Nothing here provisions or deploys a host.

See [Phase 3 report](../../docs/phase3-secure-realtime.md) for contracts, tests and device QA.
