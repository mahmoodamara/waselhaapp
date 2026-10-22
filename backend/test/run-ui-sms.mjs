// Own the Node child directly on Windows: shell-based cleanup can leave an orphan
// with a closed stdout pipe, causing the next browser run to connect to a dying fixture.
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fork(fileURLToPath(new URL("./ui-sms-server.mjs", import.meta.url)), [],
  { cwd: root, stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SMS browser fixture startup timed out")), 15000);
    const ready = message => { if (message === "ready") { clearTimeout(timer); resolve(); } };
    fixture.on("message", ready);
    fixture.once("exit", code => { clearTimeout(timer); reject(new Error(`SMS fixture exited (${code})`)); });
    fixture.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const browserFile = process.argv[2] === "customer" ? "./ui/customer-simple.py" : "./ui/sms.py";
  const browser = spawn("python", [fileURLToPath(new URL(browserFile, import.meta.url))],
    { cwd: root, stdio: "inherit", windowsHide: true });
  const [code] = await once(browser, "exit");
  process.exitCode = code ?? 1;
} finally {
  if (fixture.exitCode === null && fixture.connected) {
    const closed = once(fixture, "exit");
    const timer = setTimeout(() => fixture.kill(), 5000);
    fixture.send("shutdown");
    await closed;
    clearTimeout(timer);
  }
}
