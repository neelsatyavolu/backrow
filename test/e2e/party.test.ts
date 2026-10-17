// Runs against a live server: `npm run dev` in one terminal, then
// `BACKROW_SERVER=http://localhost:8787 npm run test:e2e`.
import { describe, expect, it } from "vitest";
import { importKey, newKeyText, openJson, sealJson } from "../../shared/crypto";
import { CHUNK_PLAIN, CHUNK_SEALED, CHUNKS_PER_PART, chunkCount, importMediaKey, openChunk, sealChunk, sealedSpan } from "../../shared/media-crypto";
import { PartyClient, type PartyEvent } from "../../shared/party-client";

const SERVER = process.env.BACKROW_SERVER ?? "http://localhost:8787";
const video = { service: "youtube", id: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Test" };

function next(client: PartyClient, type: PartyEvent["type"], timeout = 5000): Promise<PartyEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeout);
    const off = client.on((e) => {
      if (e.type === type) {
        clearTimeout(timer);
        off();
        resolve(e);
      }
    });
  });
}

async function createRoom(keyText: string) {
  const blob = await sealJson(await importKey(keyText), video);
  const res = await fetch(`${SERVER}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ video: blob }) });
  expect(res.status).toBe(200);
  return (await res.json()) as { roomId: string; hostKey: string };
}

describe("live party", () => {
  it("relays encrypted chat, state and host-only control", async () => {
    const keyText = newKeyText();
    const { roomId, hostKey } = await createRoom(keyText);

    const info = (await (await fetch(`${SERVER}/api/rooms/${roomId}`)).json()) as { video: string };
    expect(JSON.stringify(info)).not.toContain("dQw4w9WgXcQ");
    expect(await openJson(await importKey(keyText), info.video)).toEqual(video);

    const host = new PartyClient({ server: SERVER, roomId, keyText, hostKey, profile: { name: "Host", color: 0 } });
    const hostSnap = await next(host, "snapshot");
    expect(hostSnap.type === "snapshot" && hostSnap.snapshot.host === hostSnap.snapshot.you).toBe(true);

    const guest = new PartyClient({ server: SERVER, roomId, keyText, profile: { name: "Guest", color: 3 } });
    const joined = next(host, "member-join");
    const guestSnap = await next(guest, "snapshot");
    expect(guestSnap.type === "snapshot" && guestSnap.snapshot.video?.id).toBe("dQw4w9WgXcQ");
    const j = await joined;
    expect(j.type === "member-join" && j.member.name).toBe("Guest");

    const chat = next(guest, "chat");
    await host.sendChat("hello there");
    const c = await chat;
    expect(c.type === "chat" && c.entry.text).toBe("hello there");
    expect(c.type === "chat" && c.entry.name).toBe("Host");

    const state = next(guest, "state");
    await host.sendState({ playing: true, position: 42, rate: 1, duration: 212 });
    const s = await state;
    expect(s.type === "state" && s.state.position).toBe(42);

    const control = next(guest, "control");
    host.setControl("host");
    await control;
    const denied = next(guest, "error");
    guest["send"]({ t: "state", blob: await sealJson(await importKey(keyText), { playing: false, position: 1, rate: 1, duration: 212, at: Date.now() }) });
    const err = await denied;
    expect(err.type === "error" && err.code).toBe("host-only");

    // A client with the wrong key sees nothing readable.
    const outsider = new PartyClient({ server: SERVER, roomId, keyText: newKeyText(), profile: { name: "Eve", color: 1 } });
    const o = await next(outsider, "snapshot");
    expect(o.type === "snapshot" && o.snapshot.video).toBeNull();
    expect(o.type === "snapshot" && o.snapshot.chat).toHaveLength(0);

    for (const cl of [host, guest, outsider]) cl.close();
  });

  it("rejects unknown rooms", async () => {
    expect((await fetch(`${SERVER}/api/rooms/abcdefghijkm`)).status).toBe(404);
  });

  it("uploads, stores ciphertext only, and reads back any range", async () => {
    const size = CHUNK_PLAIN * CHUNKS_PER_PART + 12345; // two parts
    const plain = new Uint8Array(size);
    for (let i = 0; i < size; i++) plain[i] = (i * 31) & 255;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await importMediaKey(raw);

    const start = await fetch(`${SERVER}/api/uploads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size }) });
    expect(start.status).toBe(200);
    const s = (await start.json()) as { mediaId: string; uploadId: string; token: string; parts: number };
    expect(s.parts).toBe(2);
    const qs = new URLSearchParams({ upload: s.uploadId, token: s.token, size: String(size) });

    const parts = [];
    for (let p = 1; p <= s.parts; p++) {
      const sealed = [];
      for (let i = (p - 1) * CHUNKS_PER_PART; i < Math.min(chunkCount(size), p * CHUNKS_PER_PART); i++) {
        sealed.push(await sealChunk(key, i, plain.slice(i * CHUNK_PLAIN, (i + 1) * CHUNK_PLAIN)));
      }
      const body = new Blob(sealed);
      const res = await fetch(`${SERVER}/api/uploads/${s.mediaId}/${p}?${qs}`, { method: "PUT", body });
      expect(res.status).toBe(200);
      parts.push(await res.json());
    }
    const bad = await fetch(`${SERVER}/api/uploads/${s.mediaId}/1?${new URLSearchParams({ upload: s.uploadId, token: "x".repeat(43), size: String(size) })}`, { method: "PUT", body: "x" });
    expect(bad.status).toBe(403);

    const done = await fetch(`${SERVER}/api/uploads/${s.mediaId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: s.uploadId, token: s.token, size, parts }),
    });
    expect(done.status).toBe(200);

    // Last chunk (partial) and a middle chunk decrypt back to the original bytes.
    for (const i of [8, 3]) {
      const [a, b] = sealedSpan(i, i, size);
      const res = await fetch(`${SERVER}/media/${s.mediaId}`, { headers: { Range: `bytes=${a}-${b}` } });
      expect(res.status).toBe(206);
      const sealed = new Uint8Array(await res.arrayBuffer());
      expect(sealed.length).toBe(b - a + 1);
      expect(sealed.slice(0, 64)).not.toEqual(plain.slice(i * CHUNK_PLAIN, i * CHUNK_PLAIN + 64));
      const opened = await openChunk(key, i, sealed);
      expect(opened).toEqual(plain.slice(i * CHUNK_PLAIN, (i + 1) * CHUNK_PLAIN));
    }
    expect(CHUNK_SEALED).toBe(CHUNK_PLAIN + 16);

    const keyText = newKeyText();
    const blob = await sealJson(await importKey(keyText), { service: "upload", id: s.mediaId });
    const room = await fetch(`${SERVER}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ video: blob, mediaId: s.mediaId }) });
    expect(room.status).toBe(200);
  });
});
