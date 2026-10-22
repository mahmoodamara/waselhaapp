// Only the public API and Socket.IO go to Render. Credentials, consent, pricing
// and allowed browser origins continue to be checked by the original backend.
export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const proxy = ["/api", "/socket.io"].some(path => incoming.pathname === path || incoming.pathname.startsWith(path + "/"));
    if (!proxy) return env.ASSETS.fetch(request);

    try {
      const backend = new URL(env.BACKEND_ORIGIN);
      if (backend.protocol !== "https:" || backend.username || backend.password ||
          backend.pathname !== "/" || backend.search || backend.hash || backend.host === incoming.host)
        throw new Error("invalid backend configuration");
      // Assign the host rather than resolving an untrusted path against a base:
      // paths such as /api//other-host can never select another upstream.
      incoming.protocol = backend.protocol;
      incoming.host = backend.host;
      const headers = new Headers(request.headers);
      headers.delete("Host");
      headers.delete("Forwarded");
      for (const key of [...headers.keys()]) if (key.startsWith("x-forwarded-")) headers.delete(key);
      const clientIp = request.headers.get("CF-Connecting-IP");
      if (clientIp) headers.set("X-Forwarded-For", clientIp);
      headers.set("X-Forwarded-Proto", "https");
      // Preserve Origin, Authorization and the request body. In particular, do
      // not disguise an unapproved browser origin to bypass Socket.IO checks.
      const upstream = new Request(incoming, request);
      const response = await fetch(new Request(upstream, { headers, redirect: "manual" }), {
        cf: { cacheEverything: false, cacheTtl: 0 },
      });
      // Return the native upgrade response to preserve the WebSocket tunnel.
      if (response.status === 101) return response;
      const result = new Response(response.body, response);
      result.headers.set("Cache-Control", "no-store");
      result.headers.set("Referrer-Policy", "no-referrer");
      result.headers.set("X-Content-Type-Options", "nosniff");
      return result;
    } catch {
      // Customer link secrets and provider details must never enter logs.
      return Response.json({ code: "network_error" }, { status: 503,
        headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }
  },
};
