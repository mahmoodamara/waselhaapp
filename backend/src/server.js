import mongoose from "mongoose";
import { createServer } from "node:http";
import { attachRealtime } from "./realtime/index.js";
import { connectLocationStore } from "./services/locationStore.js";
import { config } from "./config.js";
import { connectDatabase } from "./models/index.js";
import { createApp } from "./app.js";
import { initializeLegacyDeadlines, startOrderTimeoutWorker, stopOrderTimeoutWorker } from "./services/orderTimeouts.js";
import { assertProductionReady, productionConfigProblems } from "./services/startupChecks.js";
import { log } from "./services/log.js";
import { startPrivacyRetention } from './services/privacyRetention.js';
if (!config.jwtSecret) {
  console.error("Set JWT_SECRET in backend/.env (copy .env.example).");
  process.exit(1);
}
if (config.protectedEnvironment) {
  const problems = productionConfigProblems(config);
  if (problems.length) {
    console.error(`Refusing deployed configuration:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
}
// An unexpected error leaves the process in an unknown state: log it and exit so
// the supervisor (systemd/pm2/docker restart policy) starts a clean instance.
for (const event of ["unhandledRejection", "uncaughtException"])
  process.on(event, (error) => {
    log("error", event, { error: error?.message ?? String(error) });
    process.exit(1);
  });
await connectDatabase();
if (!config.routingBaseUrl) console.warn("Route pricing unavailable: set ROUTING_BASE_URL to the running OSRM service in backend/.env.");
if (config.protectedEnvironment) {
  try { await assertProductionReady(config); }
  catch (error) { console.error(error.message); process.exit(1); }
}
console.log(`Order deadlines initialized: ${await initializeLegacyDeadlines()}`);
const { client: redis, store: locationStore, close: closeLocationStore } = await connectLocationStore();
startOrderTimeoutWorker();
const stopPrivacyRetention = startPrivacyRetention();
const server = createServer(createApp({ locationStore, redis }));
const realtime = attachRealtime(server, locationStore);
server.listen(config.port, config.host, () =>
  console.log(`Waselha: http://localhost:${config.port} (API + web).`),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await stopOrderTimeoutWorker();
  await realtime.close();
  closeLocationStore();
  stopPrivacyRetention();
  if (redis.isOpen) redis.destroy();
  await mongoose.disconnect();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
