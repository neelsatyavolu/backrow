// Background service worker: owns one encrypted party connection per tab, so
// a party survives page navigations (next episode, reloads).

import { importKey, newKeyText, sealJson } from "../../shared/crypto";
import { PartyClient } from "../../shared/party-client";
import { AVATAR_COLORS, parseProfile, type Profile } from "../../shared/payload";
import { ROOM_ID_RE } from "../../shared/protocol";
import { parseVideoUrl, serviceForHost, type StreamingVideo } from "../../shared/services";
import { inviteUrl, SERVER, type PopupStatus, type PortIn, type PortOut, type RuntimeIn, type SessionInfo } from "./messages";

interface Saved {
  roomId: string;
  keyText: string;
  hostKey?: string;
  hostOnly?: boolean;
}

interface Live {
  saved: Saved;
  client: PartyClient;
}

const live = new Map<number, Live>();
const ports = new Map<number, chrome.runtime.Port>();
const here = new Map<number, StreamingVideo | null>();

const tabKey = (tabId: number) => `tab:${tabId}`;

async function getProfile(): Promise<Profile> {
  const { profile } = await chrome.storage.sync.get("profile");
  const parsed = parseProfile(profile);
  if (parsed) return parsed;
  const fresh: Profile = {
    name: `Guest ${Math.floor(100 + Math.random() * 900)}`,
    color: Math.floor(Math.random() * AVATAR_COLORS.length),
  };
  await chrome.storage.sync.set({ profile: fresh });
  return fresh;
}

function info(l: Live): SessionInfo {
  return {
    roomId: l.saved.roomId,
    invite: inviteUrl(l.saved.roomId, l.saved.keyText),
    snapshot: l.client.room,
    status: l.client.connection,
    offset: l.client.clock.offset,
  };
}

function post(tabId: number, msg: PortOut): void {
  try {
    ports.get(tabId)?.postMessage(msg);
  } catch {
    ports.delete(tabId);
  }
}

async function pushSession(tabId: number): Promise<void> {
  const l = live.get(tabId);
  post(tabId, { type: "session", session: l ? info(l) : null, profile: await getProfile() });
}

async function open(tabId: number, saved: Saved): Promise<Live> {
  live.get(tabId)?.client.close();
  const client = new PartyClient({ server: SERVER, roomId: saved.roomId, keyText: saved.keyText, hostKey: saved.hostKey, profile: await getProfile() });
  const entry: Live = { saved, client };
  live.set(tabId, entry);
  client.on((event) => {
    if (event.type === "snapshot" && saved.hostOnly && event.snapshot.host === event.snapshot.you && event.snapshot.control !== "host") {
      client.setControl("host");
    }
    if (event.type === "status" && event.status === "closed" && live.get(tabId) === entry) {
      void forget(tabId);
    }
    post(tabId, { type: "event", event, offset: client.clock.offset });
  });
  return entry;
}

/** Restores a party after the service worker was suspended. */
async function ensure(tabId: number): Promise<Live | undefined> {
  const existing = live.get(tabId);
  if (existing) return existing;
  const saved = (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)] as Saved | undefined;
  return saved ? open(tabId, saved) : undefined;
}

async function forget(tabId: number): Promise<void> {
  const l = live.get(tabId);
  live.delete(tabId);
  l?.client.close();
  await chrome.storage.session.remove(tabKey(tabId));
  await pushSession(tabId);
}

async function start(tabId: number, hostOnly: boolean): Promise<{ ok: boolean; error?: string }> {
  const video = here.get(tabId);
  if (!video) return { ok: false, error: "Start playing a video first." };
  const keyText = newKeyText();
  const blob = await sealJson(await importKey(keyText), video);
  let res: Response;
  try {
    res = await fetch(`${SERVER}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video: blob }),
    });
  } catch {
    return { ok: false, error: "Could not reach the Backrow server. Check your connection." };
  }
  const body = (await res.json().catch(() => ({}))) as { roomId?: string; hostKey?: string; error?: string };
  if (!res.ok || !body.roomId || !body.hostKey) return { ok: false, error: body.error ?? "Could not start a party." };
  const saved: Saved = { roomId: body.roomId, keyText, hostKey: body.hostKey, hostOnly };
  await chrome.storage.session.set({ [tabKey(tabId)]: saved });
  await open(tabId, saved);
  await pushSession(tabId);
  return { ok: true };
}

async function join(tabId: number, roomId: string, keyText: string, url: string): Promise<void> {
  const video = parseVideoUrl(url);
  if (!ROOM_ID_RE.test(roomId) || !/^[A-Za-z0-9_-]{43}$/.test(keyText) || !video) return;
  const current = live.get(tabId);
  if (current && current.saved.roomId === roomId) return;
  const saved: Saved = { roomId, keyText };
  await chrome.storage.session.set({ [tabKey(tabId)]: saved });
  await open(tabId, saved);
  await chrome.tabs.update(tabId, { url: video.url });
}

async function handlePort(tabId: number, msg: PortIn): Promise<void> {
  if (msg.type === "here") {
    here.set(tabId, msg.video);
    return;
  }
  if (msg.type === "leave") return forget(tabId);
  if (msg.type === "profile") {
    const profile = parseProfile(msg.profile);
    if (!profile) return;
    await chrome.storage.sync.set({ profile });
    for (const l of live.values()) await l.client.setProfile(profile);
    return;
  }
  const l = live.get(tabId);
  if (!l) return;
  switch (msg.type) {
    case "state":
      return l.client.sendState(msg.state);
    case "video":
      return l.client.sendVideo(msg.video);
    case "chat":
      return l.client.sendChat(msg.text);
    case "react":
      return l.client.sendReaction(msg.emoji);
    case "typing":
      return l.client.setTyping(msg.on);
    case "control":
      return l.client.setControl(msg.mode);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (port.name !== "party" || tabId === undefined) return;
  ports.set(tabId, port);
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
  port.onMessage.addListener((msg: PortIn) => {
    handlePort(tabId, msg).catch((err) => console.error("[backrow] port message failed", err));
  });
  ensure(tabId)
    .then(() => pushSession(tabId))
    .catch((err) => console.error("[backrow] restore failed", err));
});

chrome.runtime.onMessage.addListener((msg: RuntimeIn, sender, reply) => {
  const run = async (): Promise<unknown> => {
    switch (msg.type) {
      case "popup-status": {
        const tab = await chrome.tabs.get(msg.tabId);
        const host = tab.url ? new URL(tab.url).hostname : "";
        const l = await ensure(msg.tabId);
        const status: PopupStatus = {
          supported: serviceForHost(host) !== null,
          video: here.get(msg.tabId) ?? (tab.url ? parseVideoUrl(tab.url) : null),
          session: l ? info(l) : null,
          profile: await getProfile(),
        };
        return status;
      }
      case "start":
        return start(msg.tabId, msg.hostOnly);
      case "leave":
        await forget(msg.tabId);
        return { ok: true };
      case "get-profile":
        return getProfile();
      case "set-profile": {
        await handlePort(-1, { type: "profile", profile: msg.profile });
        for (const tabId of ports.keys()) await pushSession(tabId);
        return { ok: true };
      }
      case "join": {
        const tabId = sender.tab?.id;
        if (tabId === undefined || !sender.url?.startsWith(`${SERVER}/p/`)) return { ok: false };
        await join(tabId, msg.roomId, msg.keyText, msg.url);
        return { ok: true };
      }
    }
  };
  run().then(reply, (err) => {
    console.error("[backrow] request failed", err);
    reply({ ok: false, error: "Something went wrong." });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  here.delete(tabId);
  void forget(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url || !live.has(tabId)) return;
  const url = new URL(change.url);
  const onParty = serviceForHost(url.hostname) !== null || change.url.startsWith(`${SERVER}/p/`);
  if (!onParty) void forget(tabId);
});
