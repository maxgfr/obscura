/**
 * Static server for dist/, plus a mock WHIP ingest at /whip that records
 * what it receives (for the live-mode tests). It answers with a placeholder
 * SDP only when asked for one by a test; otherwise it rejects the offer.
 */
import { join, normalize } from "node:path";

export interface WhipLog {
  method: string;
  auth: string | null;
  type: string | null;
  body: string;
}

export interface AppServer {
  port: number;
  whip: WhipLog[];
  stop(): void;
}

export function serveApp(opts: { port: number; dir: string }): AppServer {
  const whip: WhipLog[] = [];
  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/whip")) {
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "POST, DELETE, OPTIONS",
          "access-control-expose-headers": "location",
        };
        if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
        whip.push({
          method: req.method,
          auth: req.headers.get("authorization"),
          type: req.headers.get("content-type"),
          body: await req.text(),
        });
        if (url.pathname === "/whip/log") return Response.json(whip, { headers: cors });
        if (req.method === "DELETE") return new Response(null, { status: 200, headers: cors });
        // No real media server here: the offer is logged, then refused.
        return new Response("mock ingest", { status: 503, headers: cors });
      }
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      if (path.endsWith("/")) path += "index.html";
      const file = Bun.file(join(opts.dir, path));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = {};
      if (path.endsWith(".webmanifest")) headers["content-type"] = "application/manifest+json";
      return new Response(file, { headers });
    },
  });
  return { port: server.port ?? opts.port, whip, stop: () => server.stop(true) };
}
