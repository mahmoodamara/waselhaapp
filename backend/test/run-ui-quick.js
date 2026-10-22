// Run the isolated fixture and Python browser suite, cleaning up both children
// on Windows as well as Unix (no intermediate shell that could orphan Node).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const uri = process.env.UI_FINANCE_TEST_URI;
if (!uri || !new URL(uri).pathname.endsWith("_test"))
  throw new Error("Set UI_FINANCE_TEST_URI to a dedicated *_test database. It will be reset.");
let server, browserTest;
const stop = async child => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill(); await exited;
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  await stop(browserTest); await stop(server); process.exit(1);
});
try {
  server = spawn(process.execPath, ["backend/test/ui-finance-server.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let logs = "";
    const timer = setTimeout(() => reject(new Error(`UI fixture did not start:\n${logs}`)), 60000);
    const finish = fn => value => { clearTimeout(timer); fn(value); };
    server.once("error", finish(reject));
    server.once("exit", finish(code => reject(new Error(`UI fixture exited (${code}):\n${logs}`))));
    server.stderr.on("data", chunk => { logs += chunk; });
    server.stdout.on("data", chunk => {
      logs += chunk;
      if (logs.includes("STEP 8 isolated UI fixture ready")) finish(resolve)();
    });
  });
  browserTest = spawn(process.env.PYTHON || "python", ["-u", "backend/test/ui/quick-delivery.py"], { cwd: root, stdio: "inherit" });
  const [code] = await once(browserTest, "exit");
  process.exitCode = code ?? 1;
} finally {
  await stop(browserTest); await stop(server);
}
