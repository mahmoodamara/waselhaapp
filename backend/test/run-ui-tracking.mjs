// Direct children + IPC shutdown: Windows shell termination would orphan Node.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
if (!process.env.TRACKING_UI_TEST_URI || !new URL(process.env.TRACKING_UI_TEST_URI).pathname.endsWith("_test") || !process.env.REDIS_TEST_URL)
  throw new Error("Set TRACKING_UI_TEST_URI (*_test) and REDIS_TEST_URL");
let server, browser;
async function stop(child, graceful = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    if (graceful && child.connected) child.send("shutdown"); else child.kill();
    await exited;
  } finally { clearTimeout(timer); }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  await stop(browser); await stop(server, true); process.exit(1);
});
try {
  server = spawn(process.execPath, ["backend/test/ui-tracking-server.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  await new Promise((resolve, reject) => {
    let logs = "";
    const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 15000);
    const finish = fn => value => { clearTimeout(timer); fn(value); };
    server.once("error", finish(reject));
    server.once("exit", finish(code => reject(new Error(`Fixture exited (${code}): ${logs}`))));
    server.stderr.on("data", chunk => { logs += chunk; });
    server.stdout.on("data", chunk => { logs += chunk; if (logs.includes("Phase7 UI fixture ready")) finish(resolve)(); });
  });
  browser = spawn(process.env.PYTHON || "python", ["-u", "backend/test/ui/customer-tracking.py"], { cwd: root, stdio: "inherit" });
  const [code] = await once(browser, "exit"); process.exitCode = code ?? 1;
} finally { await stop(browser); await stop(server, true); }
