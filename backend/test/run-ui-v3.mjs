import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../../", import.meta.url));
if (!process.env.UI_FINANCE_TEST_URI || !new URL(process.env.UI_FINANCE_TEST_URI).pathname.endsWith("_test")) throw new Error("Set UI_FINANCE_TEST_URI to a dedicated *_test database");
let server, browser;
const stop = async child => { if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill(); await done; } };
try {
  server = spawn(process.execPath, ["backend/test/ui-finance-server.mjs"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let logs = "";
    const timer = setTimeout(() => reject(new Error(logs)), 60000);
    server.on("exit", () => { clearTimeout(timer); reject(new Error(logs)); });
    server.stderr.on("data", chunk => { logs += chunk; });
    server.stdout.on("data", chunk => { logs += chunk; if (logs.includes("STEP 8 isolated UI fixture ready")) { clearTimeout(timer); resolve(); } });
  });
  browser = spawn("python", ["-u", "backend/test/ui/workflow-v3.py"], { cwd, stdio: "inherit", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  const [code] = await once(browser, "exit"); process.exitCode = code ?? 1;
} finally { await stop(browser); await stop(server); }
