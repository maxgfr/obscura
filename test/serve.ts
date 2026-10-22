/**
 * Static server for dist/, plus a mock WHIP ingest at /whip that records
 * what it receives (for the live-mode tests), and a minimal Nostr relay at
 * /relay (ephemeral events only, filtered by "#x" tag) for room tests. The
 * relay logs every event it passes on, so tests can check what it sees.
 */

import { join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";

export interface WhipLog {
  method: string;
  auth: string | null;
  type: string | null;
  body: string;
}

interface RelayEvent {
  id: string;
  kind: number;
  tags: string[][];
  content: string;
}

type Socket = ServerWebSocket<{ subs: Map<string, string[]> }>;

export interface AppServer {
  port: number;
  whip: WhipLog[];
  relay: RelayEvent[];
  stop(): void;
}

export function serveApp(opts: { port: number; dir: string }): AppServer {
  const whip: WhipLog[] = [];
  const relay: RelayEvent[] = [];
  const sockets = new Set<Socket>();
  const server = Bun.serve<{ subs: Map<string, string[]> }>({
    port: opts.port,
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, data) {
        let msg: unknown;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;
        if (msg[0] === "REQ") {
          const topics = (msg[2] as { "#x"?: string[] })["#x"] ?? [];
          ws.data.subs.set(String(msg[1]), topics);
          ws.send(JSON.stringify(["EOSE", msg[1]]));
        } else if (msg[0] === "CLOSE") {
          ws.data.subs.delete(String(msg[1]));
        } else if (msg[0] === "EVENT") {
          const ev = msg[1] as RelayEvent;
          relay.push(ev);
          ws.send(JSON.stringify(["OK", ev.id, true, ""]));
          const topic = ev.tags.find((t) => t[0] === "x")?.[1];
          for (const s of sockets)
            for (const [sub, topics] of s.data.subs)
              if (topic && topics.includes(topic)) s.send(JSON.stringify(["EVENT", sub, ev]));
        }
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/relay") {
        if (srv.upgrade(req, { data: { subs: new Map() } })) return undefined;
        if (url.searchParams.has("log")) return Response.json(relay);
        return new Response("websocket only", { status: 400 });
      }
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
      if (url.pathname === "/__frame") {
        // A neutral page (no CSP of ours) that embeds the studio, for the framing test.
        const html = `<!doctype html><title>host</title><iframe id="f" sandbox="allow-scripts allow-same-origin" src="/?nosw&framed"></iframe>`;
        return new Response(html, { headers: { "content-type": "text/html" } });
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
  return { port: server.port ?? opts.port, whip, relay, stop: () => server.stop(true) };
}
