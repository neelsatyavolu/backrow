// Content script on each supported streaming site: mounts the party
// panel and keeps the site's player in sync. The connection itself lives in
// the background worker so it survives page loads.

import type { PartyEvent, RoomSnapshot } from "../../shared/party-client";
import type { Profile } from "../../shared/payload";
import { remoteLog, type RemoteLog } from "../../shared/remote-log";
import { applyEvent } from "../../shared/room-mirror";
import { parseVideoUrl, sameVideo, serviceForHost, SERVICE_LABELS, STREAMING_SERVICES, videoKey, type StreamingVideo, type VideoRef } from "../../shared/services";
import { SyncController, type SyncLink } from "../../shared/sync-controller";
import { ChatPanel } from "../../shared/ui/panel";
import { SERVER, type PortIn, type PortOut, type SessionInfo } from "./messages";
import { createAdapter } from "./player";

const service = serviceForHost(location.hostname);

let port: chrome.runtime.Port | null = null;
let session: SessionInfo | null = null;
let room: RoomSnapshot | null = null;
let offset = 0;
let profile: Profile = { name: "Guest", color: 0 };
let panel: ChatPanel | null = null;
let hostEl: HTMLElement | null = null;
let sync: SyncController | null = null;
let lastHere: StreamingVideo | null = null;
let hadPlayer = false;
let movedNotice = "";

const player = service ? createAdapter(service) : null;

function send(msg: PortIn): void {
  try {
    port?.postMessage(msg);
  } catch {
    port = null;
  }
}

const canControl = () => !!room && (room.control === "everyone" || room.host === room.you);

let debugLog: RemoteLog | null = null;
try {
  if (localStorage.getItem("backrow:debug") === "1") debugLog = (msg, data) => console.debug("[backrow]", msg, JSON.stringify(data ?? ""));
} catch {
  // Storage blocked; stay quiet.
}
// "Send debug logs" in the extension's settings also sends the trace to Backrow.
void chrome.storage.local.get("remoteLog").then(({ remoteLog: on }) => {
  if (on === true) debugLog = remoteLog(SERVER, `ext:${service ?? location.hostname}`);
});

const link: SyncLink = {
  debug: (msg, data) => debugLog?.(msg, data),
  serverNow: () => Date.now() + offset,
  roomState: () => room?.state ?? null,
  canControl,
  sendState(state) {
    if (!room) return;
    const full = { ...state, at: Date.now() + offset };
    room = { ...room, state: { ...full, by: room.you } };
    panel?.noteOwnState(full);
    send({ type: "state", state });
  },
};

// Site names as they appear in page titles ("Watch Loki | Disney+").
const SITE_NAMES = STREAMING_SERVICES.map((s) => SERVICE_LABELS[s].replace(/[+]/g, "\\+")).join("|");
const TITLE_SUFFIX = new RegExp(`\\s*[-|•·]\\s*(${SITE_NAMES})\\s*$`, "i");
const TITLE_PREFIX = new RegExp(`^(${SITE_NAMES})\\s*:\\s*`, "i");
const SITE_ONLY = new RegExp(`^(${SITE_NAMES})$`, "i");

function currentVideo(): StreamingVideo | null {
  const v = parseVideoUrl(location.href);
  if (!v) return null;
  const title = document.title.replace(TITLE_SUFFIX, "").replace(TITLE_PREFIX, "").trim();
  return title && !SITE_ONLY.test(title) ? { ...v, title: title.slice(0, 200) } : v;
}

/** Keystrokes typed into the panel must not trigger the site's player shortcuts. */
function isolateKeys(): void {
  for (const type of ["keydown", "keyup", "keypress"]) {
    window.addEventListener(
      type,
      (e) => {
        if (hostEl && e.composedPath().includes(hostEl)) e.stopImmediatePropagation();
      },
      true,
    );
  }
}

let panelOpen = true;

/** Tells page.css whether to shrink the page beside the panel. */
function layout(): void {
  const html = document.documentElement;
  const active = !!panel && !!currentVideo();
  html.classList.toggle("backrow-watch", active);
  html.classList.toggle("backrow-open", active && panelOpen);
  // Only an element other than the page itself can't be resized: during a
  // party, fullscreen-main.ts makes the whole page fullscreen instead.
  const fs = document.fullscreenElement;
  html.classList.toggle("backrow-fs", !!fs && fs !== html);
  if (service) html.dataset.backrowSite = service;
}

/** Players lay themselves out on resize; nudge them once the width settles. */
function relayout(): void {
  layout();
  setTimeout(() => window.dispatchEvent(new Event("resize")), 270);
}

function placeHost(): void {
  layout();
  if (!hostEl) return;
  const fs = document.fullscreenElement;
  const parent = fs && !(fs instanceof HTMLVideoElement) ? fs : document.documentElement;
  if (hostEl.parentElement !== parent) parent.append(hostEl);
}

function mount(info: SessionInfo): void {
  if (panel) return;
  hostEl = document.createElement("div");
  hostEl.id = "backrow-party";
  const shadow = hostEl.attachShadow({ mode: "closed" });
  panel = new ChatPanel(shadow, {
    sendChat: (text) => send({ type: "chat", text }),
    react: (emoji) => send({ type: "react", emoji }),
    typing: (on) => send({ type: "typing", on }),
    setControl: (mode) => send({ type: "control", mode }),
    setProfile: (p) => {
      profile = p;
      send({ type: "profile", profile: p });
    },
    inviteUrl: () => session?.invite ?? info.invite,
    leave: () => send({ type: "leave" }),
    serverNow: link.serverNow,
  }, {
    docked: false,
    profile,
    onOpenChange: (open) => {
      panelOpen = open;
      relayout();
    },
  });
  placeHost();
  relayout();
  if (player) {
    sync = new SyncController(player, link);
    sync.start();
  }
}

function unmount(): void {
  sync?.stop();
  sync = null;
  panel?.destroy();
  panel = null;
  hostEl?.remove();
  hostEl = null;
  room = null;
  hadPlayer = false;
  relayout();
}

/** Brings this tab to the party's video, or explains why it can't. */
function follow(video: VideoRef | null): boolean {
  if (!video) return false;
  const here = currentVideo();
  if (sameVideo(here, video)) return false;
  if (video.service === service) {
    location.assign(video.url);
    return true;
  }
  const label = SERVICE_LABELS[video.service];
  const note = `The party is watching on ${label}.`;
  if (movedNotice !== note) {
    movedNotice = note;
    panel?.notice([note, video.service === "local" ? " Open the invite link to join it." : ` Open ${label} to follow along.`]);
  }
  return false;
}

function onSnapshot(): void {
  if (!room) return;
  if (follow(room.video)) return;
  if (sameVideo(currentVideo(), room.video)) sync?.applyRemote(room.state);
}

function onEvent(event: PartyEvent): void {
  link.debug?.(`event ${event.type}`, event.type === "state" ? event.state : event.type === "snapshot" ? { video: event.snapshot.video && videoKey(event.snapshot.video), state: event.snapshot.state } : undefined);
  room = applyEvent(room, event);
  panel?.handle(event);
  if (event.type === "snapshot") onSnapshot();
  else if (event.type === "state" && sameVideo(currentVideo(), room?.video)) sync?.applyRemote(event.state);
  else if (event.type === "video") follow(event.video);
}

function onMessage(msg: PortOut): void {
  if (msg.type === "session") {
    if (JSON.stringify(msg.profile) !== JSON.stringify(profile)) panel?.updateProfile(msg.profile);
    profile = msg.profile;
    session = msg.session;
    if (!session) {
      unmount();
      return;
    }
    offset = session.offset;
    mount(session);
    if (session.snapshot) onEvent({ type: "snapshot", snapshot: session.snapshot });
    panel?.renderStatus(session.status as "open");
    return;
  }
  offset = msg.offset;
  onEvent(msg.event);
}

function connect(): void {
  port = chrome.runtime.connect({ name: "party" });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // The background worker restarted; reconnect and it restores the party.
    setTimeout(connect, 1000);
  });
  lastHere = null;
}

/** Watches for SPA navigations (next episode, autoplay) and a player appearing. */
function poll(): void {
  const video = currentVideo();
  if (!sameVideo(video, lastHere) || video?.title !== lastHere?.title) {
    const changed = !sameVideo(video, lastHere);
    lastHere = video;
    if (changed) relayout();
    send({ type: "here", video });
    if (changed && video && room && !sameVideo(video, room.video) && canControl()) {
      // You moved to another video (next episode): take the party with you.
      room = { ...room, video, state: null };
      send({ type: "video", video });
      panel?.notice(["You changed the video"]);
    }
  }
  const hasPlayer = !!player?.snapshot();
  if (hasPlayer && !hadPlayer && room && sameVideo(video, room.video)) sync?.applyRemote(room.state);
  hadPlayer = hasPlayer;
}

if (service) {
  isolateKeys();
  connect();
  setInterval(poll, 1000);
  document.addEventListener("fullscreenchange", () => {
    placeHost();
    setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
  });
}
