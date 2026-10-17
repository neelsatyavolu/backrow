// Web player for uploaded videos: no extension needed. Decryption happens in
// the service worker (sw.ts); sync and chat use the same code as the extension.

import { importKey, openJson } from "../../shared/crypto";
import { PartyClient } from "../../shared/party-client";
import { AVATAR_COLORS, parseVideo, type Profile } from "../../shared/payload";
import type { UploadedVideo } from "../../shared/services";
import { SyncController, type PlayerAdapter, type PlayerEvent } from "../../shared/sync-controller";
import { ChatPanel } from "../../shared/ui/panel";
import { el, load, loadProfile, partyFromLocation, saveProfile } from "./local";

const video = document.getElementById("video") as HTMLVideoElement;
const screen = document.getElementById("screen")!;
const gate = document.getElementById("gate")!;
const gateCard = document.getElementById("gateCard")!;
const side = document.getElementById("side")!;

function gateMessage(title: string, detail: string, action?: HTMLElement): void {
  gateCard.replaceChildren(el("span", "label", "Backrow"), el("p", "title", title), el("p", "meta", detail), ...(action ? [action] : []));
  gate.hidden = false;
}

const adapter: PlayerAdapter = {
  canNudge: true,
  snapshot: () =>
    video.readyState === 0 || !Number.isFinite(video.duration)
      ? null
      : { playing: !video.paused, position: video.currentTime, rate: video.playbackRate, duration: video.duration },
  play: () => {
    video.play().catch(() => showUnblock());
  },
  pause: () => video.pause(),
  seek: (s) => {
    video.currentTime = s;
  },
  setRate: (r) => {
    video.playbackRate = r;
  },
  inAd: () => false,
  onEvent(cb) {
    const types: PlayerEvent[] = ["play", "pause", "seeking", "seeked", "ratechange"];
    const handler = (e: Event) => cb(e.type as PlayerEvent);
    for (const t of types) video.addEventListener(t, handler);
    return () => types.forEach((t) => video.removeEventListener(t, handler));
  },
};

let unblock: HTMLButtonElement | null = null;
function showUnblock(): void {
  if (unblock) return;
  unblock = el("button", "btn accent blocked", "Click to play in sync");
  unblock.onclick = () => {
    unblock?.remove();
    unblock = null;
    video.play().catch(() => undefined);
  };
  screen.append(unblock);
}

async function startWorker(media: UploadedVideo): Promise<void> {
  if (!("serviceWorker" in navigator)) throw new Error("This browser can't play encrypted uploads. Try Chrome, Edge, Firefox or Safari.");
  const message = { type: "media", id: media.id, key: media.mediaKey, size: media.size, mime: media.mime };
  // Answer the worker if it restarts and asks for the key again.
  navigator.serviceWorker.addEventListener("message", (e) => {
    const data = e.data as { type?: string; id?: string } | undefined;
    if (data?.type === "need-media" && data.id === media.id) e.ports[0]?.postMessage(message);
  });
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  const reg = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  }
  const target = navigator.serviceWorker.controller ?? reg.active;
  await new Promise<void>((resolve, reject) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("The video decoder did not start. Reload the page.")), 5000);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      (e.data as { ok: boolean }).ok ? resolve() : reject(new Error("The video key is invalid."));
    };
    target?.postMessage(message, [ch.port2]);
  });
}

function askProfile(media: UploadedVideo, members: number): Promise<Profile> {
  return new Promise((resolve) => {
    let profile = loadProfile();
    const name = el("input", "field");
    name.value = profile.name;
    name.maxLength = 24;
    name.setAttribute("aria-label", "Your name");
    const swatches = el("div", "swatches");
    const paint = () =>
      swatches.replaceChildren(
        ...AVATAR_COLORS.map((c, i) => {
          const b = el("button", "swatch");
          b.style.background = c;
          b.setAttribute("aria-label", `Color ${i + 1}`);
          b.setAttribute("aria-pressed", String(i === profile.color));
          b.onclick = () => {
            profile = { ...profile, color: i };
            paint();
          };
          return b;
        }),
      );
    paint();
    const join = el("button", "btn accent", "Join party");
    const go = () => {
      profile = { ...profile, name: name.value.trim().slice(0, 24) || profile.name };
      saveProfile(profile);
      resolve(profile);
    };
    join.onclick = go;
    name.addEventListener("keydown", (e) => e.key === "Enter" && go());
    gateCard.replaceChildren(
      el("span", "label", `Uploaded video · ${members} watching`),
      el("p", "title", media.name),
      el("span", "label", "Your name"),
      name,
      swatches,
      join,
      el("p", "meta", "The video and chat are end-to-end encrypted. The file is deleted within a day."),
    );
    name.focus();
  });
}

async function run(): Promise<void> {
  const party = partyFromLocation();
  if (!party) return gateMessage("This link is incomplete", "Ask for the invite link again, including the part after #.");
  const res = await fetch(`/api/rooms/${party.roomId}`);
  if (res.status === 404) return gateMessage("This party has ended", "Parties and their videos are deleted a few hours after everyone leaves.");
  if (!res.ok) return gateMessage("Could not open the party", "Check your connection and reload.");
  const info = (await res.json()) as { video: string; members: number };
  const media = parseVideo(await openJson(await importKey(party.keyText), info.video));
  if (!media) return gateMessage("This link doesn't open", "The key in the link is wrong or was cut off.");
  if (media.service !== "upload") {
    location.replace(`/p/${party.roomId}#${party.keyText}`);
    return;
  }

  const workerReady = startWorker(media);
  const profile = await askProfile(media, info.members);
  gateMessage("Loading video", "Decrypting the first few seconds.");
  await workerReady;

  const client = new PartyClient({
    server: location.origin,
    roomId: party.roomId,
    keyText: party.keyText,
    hostKey: load(`backrow:host:${party.roomId}`) ?? undefined,
    profile,
  });
  const invite = `${location.origin}/p/${party.roomId}#${party.keyText}`;
  const panelHost = el("div");
  side.append(panelHost);
  const panel = new ChatPanel(panelHost.attachShadow({ mode: "open" }), {
    sendChat: (t) => void client.sendChat(t),
    react: (e) => void client.sendReaction(e),
    typing: (on) => client.setTyping(on),
    setControl: (m) => client.setControl(m),
    setProfile: (p) => {
      saveProfile(p);
      void client.setProfile(p);
    },
    inviteUrl: () => invite,
    leave: () => {
      client.close();
      location.assign("/");
    },
    serverNow: () => client.serverNow(),
  }, { docked: true, profile });

  const sync = new SyncController(adapter, {
    serverNow: () => client.serverNow(),
    roomState: () => client.room?.state ?? null,
    canControl: () => client.canControl,
    sendState: (s) => {
      void client.sendState(s);
      const st = client.room?.state;
      if (st) panel.noteOwnState(st);
    },
  });

  const hostOnly = load(`backrow:hostonly:${party.roomId}`) === "1";
  client.on((e) => {
    panel.handle(e);
    if (e.type === "snapshot") {
      if (hostOnly && e.snapshot.host === e.snapshot.you && e.snapshot.control !== "host") client.setControl("host");
      if (video.readyState > 0) sync.applyRemote(e.snapshot.state);
    } else if (e.type === "state") {
      sync.applyRemote(e.state);
    } else if (e.type === "status" && e.status === "closed") {
      gateMessage("Disconnected", "This party has ended or the link is no longer valid.");
    }
  });

  video.addEventListener("loadedmetadata", () => {
    gate.hidden = true;
    sync.applyRemote(client.room?.state ?? null);
  }, { once: true });
  video.addEventListener("error", () => {
    gateMessage("This video can't play here", "The browser couldn't decode this file. MP4 with H.264 video and AAC audio works everywhere.");
  });
  video.src = `/stream/${media.id}`;
  sync.start();
}

run().catch((err) => {
  console.error("[backrow] watch failed", err);
  gateMessage("Something went wrong", err instanceof Error ? err.message : "Reload the page to try again.");
});
