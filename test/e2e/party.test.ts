// Runs against a live server: `npm run dev` in one terminal, then
// `BACKROW_SERVER=http://localhost:8787 npm run test:e2e`.
import { describe, expect, it } from "vitest";
import { importKey, newKeyText, openJson, sealJson } from "../../shared/crypto";
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
    expect(guestSnap.type === "snapshot" && guestSnap.snapshot.video?.service === "youtube" && guestSnap.snapshot.video.id).toBe("dQw4w9WgXcQ");
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

  it("relays encrypted WebRTC signals to one member only", async () => {
    const keyText = newKeyText();
    const { roomId, hostKey } = await createRoom(keyText);
    const host = new PartyClient({ server: SERVER, roomId, keyText, hostKey, profile: { name: "Host", color: 0 } });
    const hs = await next(host, "snapshot");
    const viewer = new PartyClient({ server: SERVER, roomId, keyText, profile: { name: "Viewer", color: 1 } });
    await next(viewer, "snapshot");
    const hostId = hs.type === "snapshot" ? hs.snapshot.you : "";
    const got = next(host, "signal");
    await viewer.sendSignal(hostId, { kind: "want" });
    const sig = await got;
    expect(sig.type === "signal" && sig.data).toEqual({ kind: "want" });
    host.close();
    viewer.close();
  });

  it("serves ICE servers", async () => {
    const body = (await (await fetch(`${SERVER}/api/ice`)).json()) as { iceServers: Array<{ urls: string }> };
    expect(body.iceServers[0]?.urls).toContain("stun:");
  });
});
