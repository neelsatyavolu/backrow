// Service worker for uploaded videos. The <video> element asks for
// /stream/<id> with ordinary Range requests; this worker fetches the matching
// encrypted chunks from R2, decrypts them in the browser and answers with
// plain bytes. The server never sees the key or the video.

import { fromBase64Url } from "../../shared/crypto";
import { CHUNK_PLAIN, chunkCount, importMediaKey, openChunk, sealedSpan } from "../../shared/media-crypto";

declare const self: ServiceWorkerGlobalScope;

interface Media {
  key: CryptoKey;
  size: number;
  mime: string;
}

interface MediaMessage {
  type: "media";
  id: string;
  key: string;
  size: number;
  mime: string;
}

/** Bytes returned per range response. Small enough to start fast, big enough to keep up. */
const SPAN_CHUNKS = 4;
const READ_AHEAD_CHUNKS = 6;
const CACHE_CHUNKS = 48;

const media = new Map<string, Media>();
const chunks = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function register(msg: MediaMessage): Promise<Media> {
  const entry: Media = { key: await importMediaKey(fromBase64Url(msg.key)), size: msg.size, mime: msg.mime };
  media.set(msg.id, entry);
  return entry;
}

self.addEventListener("message", (e) => {
  const msg = e.data as MediaMessage | undefined;
  if (msg?.type !== "media" || !/^[a-z2-9]{16}$/.test(msg.id)) return;
  e.waitUntil(
    register(msg).then(
      () => e.ports[0]?.postMessage({ ok: true }),
      () => e.ports[0]?.postMessage({ ok: false }),
    ),
  );
});

/** After a worker restart the key is gone; ask the open watch pages for it again. */
async function recover(id: string): Promise<Media | null> {
  const pages = await self.clients.matchAll({ type: "window" });
  for (const page of pages) {
    const reply = await new Promise<MediaMessage | null>((resolve) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 1500);
      ch.port1.onmessage = (ev) => {
        clearTimeout(timer);
        resolve(ev.data as MediaMessage | null);
      };
      page.postMessage({ type: "need-media", id }, [ch.port2]);
    });
    if (reply?.type === "media" && reply.id === id) return register(reply);
  }
  return null;
}

function remember(key: string, value: Promise<Uint8Array<ArrayBuffer>>): void {
  chunks.set(key, value);
  value.catch(() => chunks.delete(key));
  while (chunks.size > CACHE_CHUNKS) chunks.delete(chunks.keys().next().value!);
}

/** Fetches chunks first..last in one ranged request and caches each decrypted chunk. */
function load(id: string, m: Media, first: number, last: number): void {
  const missing: number[] = [];
  for (let i = first; i <= last; i++) if (!chunks.has(`${id}:${i}`)) missing.push(i);
  if (missing.length === 0) return;
  const from = missing[0]!;
  const to = missing[missing.length - 1]!;
  const [start, end] = sealedSpan(from, to, m.size);
  const body = fetch(`/media/${id}`, { headers: { Range: `bytes=${start}-${end}` } }).then(async (res) => {
    if (res.status !== 206) throw new Error(`media fetch failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  });
  for (let i = from; i <= to; i++) {
    const offset = (i - from) * (CHUNK_PLAIN + 16);
    remember(
      `${id}:${i}`,
      body.then((bytes) => openChunk(m.key, i, bytes.slice(offset, Math.min(offset + CHUNK_PLAIN + 16, bytes.length)))),
    );
  }
}

async function stream(request: Request, id: string): Promise<Response> {
  const m = media.get(id) ?? (await recover(id));
  if (!m) return new Response("Missing key", { status: 404 });

  const match = (request.headers.get("Range") ?? "bytes=0-").match(/^bytes=(\d+)-(\d*)$/);
  const start = match ? Number(match[1]) : 0;
  if (start >= m.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${m.size}` } });
  const first = Math.floor(start / CHUNK_PLAIN);
  const spanEnd = Math.min((first + SPAN_CHUNKS) * CHUNK_PLAIN, m.size) - 1;
  const end = match?.[2] ? Math.min(Number(match[2]), spanEnd) : spanEnd;
  const last = Math.floor(end / CHUNK_PLAIN);

  load(id, m, first, last);
  const total = chunkCount(m.size);
  load(id, m, last + 1, Math.min(total - 1, last + READ_AHEAD_CHUNKS));

  const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, k) => chunks.get(`${id}:${first + k}`)!));
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.length;
  }
  const from = start - first * CHUNK_PLAIN;
  const body = joined.slice(from, from + (end - start + 1));
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": m.mime,
      "Content-Length": String(body.length),
      "Content-Range": `bytes ${start}-${end}/${m.size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const m = url.origin === self.location.origin ? url.pathname.match(/^\/stream\/([a-z2-9]{16})$/) : null;
  if (!m) return;
  e.respondWith(
    stream(e.request, m[1]!).catch((err) => {
      console.error("[backrow] stream failed", err);
      return new Response("Could not load video", { status: 502 });
    }),
  );
});
