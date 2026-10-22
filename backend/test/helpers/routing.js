// Local OSRM-shaped HTTP fixture. No automated test contacts a live router.
import { createServer } from "node:http";
import { once } from "node:events";

export async function startFakeRouting() {
  const fake = {
    distance: 1500, mode: "ok", calls: [], handler: null,
    reset() { this.distance = 1500; this.mode = "ok"; this.calls.length = 0; this.handler = null; },
  };
  const server = createServer(async (req, res) => {
    fake.calls.push(req.url);
    server.emit("route-call");
    if (fake.handler) return fake.handler(req, res);
    if (fake.mode === "timeout") return;
    if (fake.mode === "fail") { res.statusCode = 503; return res.end("private-provider-error"); }
    if (fake.mode === "html") return res.end("<html>private-provider-error</html>");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ code: fake.mode === "no-route" ? "NoRoute" : "Ok", routes: [{ distance: fake.distance }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.waitForCalls = async (count) => {
    while (fake.calls.length < count) await once(server, "route-call");
  };
  fake.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  process.env.ROUTING_BASE_URL = fake.url;
  process.env.ROUTING_TIMEOUT_MS = "250";
  return fake;
}
