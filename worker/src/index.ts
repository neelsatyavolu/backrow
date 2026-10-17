// HTTP entry point: party creation, WebSocket hand-off to the room's Durable
// Object, encrypted video uploads to R2 and ranged playback reads.

import { randomId, toBase64Url } from "../../shared/crypto";
import { MAX_UPLOAD_BYTES, partCount, sealedSize, CHUNK_SEALED, CHUNKS_PER_PART } from "../../shared/media-crypto";
import { isBlob, MEDIA_ID_RE, ROOM_ID_RE } from "../../shared/protocol";
import type { Env } from "./env";

export { Room } from "./room";
export { Quota } from "./quota";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
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

async function sign(env: Env, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.UPLOAD_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
}

async function verify(env: Env, message: string, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length > 100) return false;
  const expected = await sign(env, message);
  // Constant-time compare.
  let diff = expected.length ^ token.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (token.charCodeAt(i) || 0);
  return diff === 0;
}

const clientIp = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "local";

async function createRoom(request: Request, env: Env): Promise<Response> {
  if (!(await env.CREATE_LIMITER.limit({ key: clientIp(request) })).success) return fail(429, "Too many parties, try again in a minute");
  const body = await readJson(request);
  if (!body || !isBlob(body.video)) return fail(400, "Invalid party");
  const mediaId = body.mediaId === undefined || body.mediaId === null ? null : body.mediaId;
  if (mediaId !== null && (typeof mediaId !== "string" || !MEDIA_ID_RE.test(mediaId))) return fail(400, "Invalid media id");
  if (mediaId && !(await env.MEDIA.head(`media/${mediaId}`))) return fail(400, "Upload not found");
  const roomId = randomId(12);
  const res = await env.ROOMS.getByName(roomId).fetch("https://room/create", {
    method: "POST",
    body: JSON.stringify({ video: body.video, mediaId }),
  });
  if (!res.ok) return fail(500, "Could not create party");
  const { hostKey } = (await res.json()) as { hostKey: string };
  return json({ roomId, hostKey });
}

async function startUpload(request: Request, env: Env): Promise<Response> {
  if (!(await env.UPLOAD_LIMITER.limit({ key: clientIp(request) })).success) return fail(429, "Too many uploads, try again later");
  const body = await readJson(request);
  const size = body?.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) return fail(400, "Invalid size");
  if (size > MAX_UPLOAD_BYTES) return fail(413, "Videos can be up to 2 GB");
  const mediaId = randomId(16);
  if (!(await env.QUOTA.getByName("global").reserve(mediaId, sealedSize(size)))) {
    return fail(507, "Upload space is full right now. Try again in a few hours.");
  }
  const upload = await env.MEDIA.createMultipartUpload(`media/${mediaId}`, {
    customMetadata: { plainSize: String(size) },
  });
  const token = await sign(env, `${mediaId}.${upload.uploadId}.${size}`);
  return json({ mediaId, uploadId: upload.uploadId, token, parts: partCount(size) });
}

async function uploadPart(request: Request, env: Env, mediaId: string, part: number): Promise<Response> {
  const url = new URL(request.url);
  const uploadId = url.searchParams.get("upload") ?? "";
  const size = Number(url.searchParams.get("size"));
  if (!(await verify(env, `${mediaId}.${uploadId}.${size}`, url.searchParams.get("token")))) return fail(403, "Invalid upload token");
  const parts = partCount(size);
  if (!Number.isInteger(part) || part < 1 || part > parts) return fail(400, "Invalid part");
  const total = sealedSize(size);
  const partBytes = CHUNK_SEALED * CHUNKS_PER_PART;
  const expected = part < parts ? partBytes : total - partBytes * (parts - 1);
  const length = Number(request.headers.get("Content-Length"));
  if (length !== expected || !request.body) return fail(400, `Part ${part} must be ${expected} bytes`);
  const uploaded = await env.MEDIA.resumeMultipartUpload(`media/${mediaId}`, uploadId).uploadPart(part, request.body);
  return json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
}

async function finishUpload(request: Request, env: Env, mediaId: string): Promise<Response> {
  const body = await readJson(request);
  const uploadId = typeof body?.uploadId === "string" ? body.uploadId : "";
  const size = Number(body?.size);
  if (!(await verify(env, `${mediaId}.${uploadId}.${size}`, body?.token))) return fail(403, "Invalid upload token");
  const parts = Array.isArray(body?.parts) ? (body.parts as Array<{ partNumber: unknown; etag: unknown }>) : [];
  const valid = parts.every((p) => Number.isInteger(p.partNumber) && typeof p.etag === "string");
  if (!valid || parts.length !== partCount(size)) return fail(400, "Missing parts");
  const upload = env.MEDIA.resumeMultipartUpload(`media/${mediaId}`, uploadId);
  const object = await upload.complete(parts.map((p) => ({ partNumber: p.partNumber as number, etag: p.etag as string })));
  if (object.size !== sealedSize(size)) {
    await env.MEDIA.delete(`media/${mediaId}`);
    return fail(400, "Upload size mismatch");
  }
  return json({ ok: true });
}

/** Parses "bytes=a-b" / "bytes=a-" into an R2 range. Suffix ranges are not needed by our player. */
export function parseRange(header: string | null): { offset: number; length?: number } | null {
  if (!header) return { offset: 0 };
  const m = header.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return null;
  const offset = Number(m[1]);
  if (!m[2]) return { offset };
  const end = Number(m[2]);
  return end >= offset ? { offset, length: end - offset + 1 } : null;
}

async function readMedia(request: Request, env: Env, mediaId: string): Promise<Response> {
  const range = parseRange(request.headers.get("Range"));
  if (!range) return fail(416, "Invalid range");
  let object: R2ObjectBody | null;
  try {
    object = await env.MEDIA.get(`media/${mediaId}`, { range });
  } catch {
    // R2 rejects ranges that start past the end of the object.
    return fail(416, "Range not satisfiable");
  }
  if (!object) return fail(404, "Video not found or expired");
  const r = object.range as { offset: number; length: number } | undefined;
  const offset = r?.offset ?? 0;
  const length = r?.length ?? object.size;
  return new Response(object.body, {
    status: 206,
    headers: {
      ...CORS,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(length),
      "Content-Range": `bytes ${offset}-${offset + length - 1}/${object.size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
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
    if (parts[1] === "uploads" && parts.length === 2 && method === "POST") return startUpload(request, env);
    if (parts[1] === "uploads" && parts.length >= 3 && MEDIA_ID_RE.test(parts[2]!)) {
      if (parts.length === 4 && method === "PUT") return uploadPart(request, env, parts[2]!, Number(parts[3]));
      if (parts.length === 4 && parts[3] === "complete" && method === "POST") return finishUpload(request, env, parts[2]!);
    }
    return fail(404, "Not found");
  }

  if (parts[0] === "media" && parts.length === 2 && MEDIA_ID_RE.test(parts[1]!) && (method === "GET" || method === "HEAD")) {
    return readMedia(request, env, parts[1]!);
  }

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
