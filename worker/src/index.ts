// HTTP entry point: party creation, WebSocket hand-off to the room's Durable
// Object, and ICE servers for peer-to-peer video streams.

import { randomId } from "../../shared/crypto";
import { isBlob, ROOM_ID_RE } from "../../shared/protocol";
import type { Env } from "./env";

export { Room } from "./room";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS });
}

function fail(status: number, error: string): Response {
  return json({ error }, status);
}

async function readJson(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const clientIp = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "local";

async function createRoom(request: Request, env: Env): Promise<Response> {
  if (!(await env.CREATE_LIMITER.limit({ key: clientIp(request) })).success) return fail(429, "Too many parties, try again in a minute");
  const body = await readJson(request);
  if (!body || !isBlob(body.video)) return fail(400, "Invalid party");
  const roomId = randomId(12);
  const res = await env.ROOMS.getByName(roomId).fetch("https://room/create", {
    method: "POST",
    body: JSON.stringify({ video: body.video }),
  });
  if (!res.ok) return fail(500, "Could not create party");
  const { hostKey } = (await res.json()) as { hostKey: string };
  return json({ roomId, hostKey });
}

/**
 * STUN lets most peers connect directly. If a Cloudflare TURN key is
 * configured (TURN_KEY_ID / TURN_KEY_TOKEN secrets), short-lived relay
 * credentials are added for networks that block direct connections.
 */
async function iceServers(env: Env): Promise<Response> {
  const servers: Array<Record<string, unknown>> = [{ urls: "stun:stun.cloudflare.com:3478" }];
  if (env.TURN_KEY_ID && env.TURN_KEY_TOKEN) {
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 6 * 60 * 60 }),
      });
      if (res.ok) {
        const body = (await res.json()) as { iceServers?: Array<Record<string, unknown>> };
        servers.push(...(body.iceServers ?? []));
      } else {
        console.error("TURN credentials failed", res.status);
      }
    } catch (err) {
      console.error("TURN credentials failed", err);
    }
  }
  return Response.json({ iceServers: servers }, { headers: { ...CORS, "Cache-Control": "no-store" } });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (parts[0] === "ws" && parts.length === 2 && ROOM_ID_RE.test(parts[1]!)) {
    return env.ROOMS.getByName(parts[1]!).fetch(new Request("https://room/ws", request));
  }

  if (parts[0] === "api") {
    if (parts[1] === "rooms" && parts.length === 2 && method === "POST") return createRoom(request, env);
    if (parts[1] === "rooms" && parts.length === 3 && method === "GET" && ROOM_ID_RE.test(parts[2]!)) {
      const res = await env.ROOMS.getByName(parts[2]!).fetch("https://room/info");
      return json(await res.json(), res.status);
    }
    if (parts[1] === "ice" && parts.length === 2 && method === "GET") return iceServers(env);
    return fail(404, "Not found");
  }

  // The host's streaming page, before a party exists.
  if (parts[0] === "host" && parts.length === 1) return env.ASSETS.fetch(new Request(new URL("/watch", url), request));

  // Pretty party links: /p/<room>#key and /watch/<room>#key.
  if ((parts[0] === "p" || parts[0] === "watch") && parts.length === 2 && ROOM_ID_RE.test(parts[1]!)) {
    const page = parts[0] === "p" ? "/join" : "/watch";
    return env.ASSETS.fetch(new Request(new URL(page, url), request));
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      console.error("request failed", request.method, new URL(request.url).pathname, err);
      return fail(500, "Something went wrong");
    }
  },
} satisfies ExportedHandler<Env>;
