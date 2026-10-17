// Watch parties for a file on the host's computer. Nothing is uploaded: the
// host's browser plays the file and streams it peer-to-peer to each viewer
// (rtc.ts). Chat, names and controls use the same encrypted party as the
// extension.

import { importKey, newKeyText, openJson, sealJson } from "../../shared/crypto";
import { PartyClient, type PartyEvent } from "../../shared/party-client";
import { parseVideo, type Profile } from "../../shared/payload";
import type { LocalVideo } from "../../shared/services";
import { expectedPosition } from "../../shared/sync";
import { SyncController, type PlayerAdapter, type PlayerEvent } from "../../shared/sync-controller";
import { ChatPanel } from "../../shared/ui/panel";
import { el, load, partyFromLocation, store } from "./local";
import { PlayerUI, type PlayerSource } from "./player-ui";
import { profileForm } from "./profile-form";
import { loadIceServers, StreamHost, StreamViewer } from "./rtc";

const video = document.getElementById("video") as HTMLVideoElement;
const screen = document.getElementById("screen")!;
const stage = document.getElementById("stage")!;
const gate = document.getElementById("gate")!;
const gateCard = document.getElementById("gateCard")!;
const side = document.getElementById("side")!;
const badge = document.getElementById("badge")!;

interface Party {
  roomId: string;
  keyText: string;
}

function gateMessage(title: string, detail: string, ...actions: HTMLElement[]): void {
  gateCard.replaceChildren(el("span", "label", "Backrow"), el("p", "title", title), el("p", "meta", detail), ...actions);
  gate.hidden = false;
}

function homeButton(): HTMLAnchorElement {
  const a = el("a", "btn ghost", "Go to Backrow");
  a.href = "/";
  return a;
}

type CaptureVideo = HTMLVideoElement & { captureStream?(): MediaStream; mozCaptureStream?(): MediaStream };

function canStream(): boolean {
  const v = video as CaptureVideo;
  return typeof v.captureStream === "function" || typeof v.mozCaptureStream === "function";
}

function capture(): MediaStream {
  const v = video as CaptureVideo;
  return v.captureStream ? v.captureStream() : v.mozCaptureStream!();
}

const localAdapter: PlayerAdapter = {
  canNudge: false,
  snapshot: () =>
    video.readyState === 0 || !Number.isFinite(video.duration)
      ? null
      : { playing: !video.paused, position: video.currentTime, rate: video.playbackRate, duration: video.duration, buffering: video.seeking },
  play: () => void video.play().catch(() => undefined),
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

/** File picker that loads the chosen file into the local <video>. */
function filePicker(onReady: (file: File) => void): HTMLElement {
  const box = el("label", "drop");
  const input = el("input");
  input.type = "file";
  input.accept = "video/*,.mkv,.mov,.m4v";
  const name = el("span", "name", "Choose a video file");
  const meta = el("span", "meta", "It stays on your computer and streams straight to your friends.");
  box.append(input, name, meta);
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    name.textContent = file.name;
    meta.textContent = "Checking the file";
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(file);
    video.onloadedmetadata = () => {
      const mins = Math.round(video.duration / 60);
      meta.textContent = `${mins} min · ready`;
      onReady(file);
    };
    video.onerror = () => {
      meta.textContent = "This browser can't play that file. MP4 (H.264 + AAC) or WebM work best.";
    };
  };
  return box;
}

function makePanel(client: PartyClient, party: Party, profile: Profile, onLeave: () => void): ChatPanel {
  const host = el("div");
  side.append(host);
  return new ChatPanel(host.attachShadow({ mode: "open" }), {
    sendChat: (t) => void client.sendChat(t),
    react: (e) => void client.sendReaction(e),
    typing: (on) => client.setTyping(on),
    setControl: (m) => client.setControl(m),
    setProfile: (p) => {
      store("backrow:profile", JSON.stringify(p));
      void client.setProfile(p);
    },
    inviteUrl: () => `${location.origin}/p/${party.roomId}#${party.keyText}`,
    leave: () => {
      client.close();
      onLeave();
      location.assign("/");
    },
    serverNow: () => client.serverNow(),
  }, {
    docked: true,
    profile,
    // Hiding the chat gives its column back to the video, animated in CSS.
    onOpenChange: (open) => stage.classList.toggle("chat-hidden", !open),
  });
}

// ---------------- Host ----------------

async function startHost(party: Party, profile: Profile, hostKey: string): Promise<void> {
  gate.hidden = true;
  const client = new PartyClient({ server: location.origin, roomId: party.roomId, keyText: party.keyText, hostKey, profile });
  let stream: MediaStream | null = null;
  let host: StreamHost | null = null;
  const panel = makePanel(client, party, profile, () => host?.closeAll());
  const sync = new SyncController(localAdapter, {
    serverNow: () => client.serverNow(),
    roomState: () => client.room?.state ?? null,
    canControl: () => client.canControl,
    sendState: (s) => {
      void client.sendState(s);
      const st = client.room?.state;
      if (st) panel.noteOwnState(st);
    },
  });
  const source: PlayerSource = {
    state: () => ({ playing: !video.paused, position: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : 0 }),
    canControl: () => client.canControl,
    toggle: () => (video.paused ? void video.play().catch(() => undefined) : video.pause()),
    seek: (s) => {
      video.currentTime = s;
    },
  };
  new PlayerUI(screen, video, stage, source);

  const ice = await loadIceServers();
  const ensureStream = (): StreamHost => {
    stream ??= capture();
    host ??= new StreamHost(client, stream, ice);
    return host;
  };
  const updateBadge = () => {
    const n = host?.viewers ?? 0;
    badge.textContent = n === 0 ? "Live · send the invite link" : `Live · streaming to ${n}`;
  };
  setInterval(updateBadge, 1000);
  badge.hidden = false;

  const hostOnly = load(`backrow:hostonly:${party.roomId}`) === "1";
  client.on((e: PartyEvent) => {
    panel.handle(e);
    if (e.type === "snapshot") {
      if (hostOnly && e.snapshot.host === e.snapshot.you && e.snapshot.control !== "host") client.setControl("host");
      sync.applyRemote(e.snapshot.state);
    } else if (e.type === "state") {
      sync.applyRemote(e.state);
    } else if (e.type === "signal") {
      void ensureStream().onSignal(e.from, e.data);
    } else if (e.type === "member-leave") {
      host?.close(e.member.id);
    } else if (e.type === "status" && e.status === "closed") {
      gateMessage("Party ended", "This party has ended or the link is no longer valid.", homeButton());
    }
  });
  window.addEventListener("beforeunload", () => host?.closeAll());
  sync.start();
}

async function newHostParty(): Promise<void> {
  if (!canStream()) {
    return gateMessage("Use Chrome, Edge or Firefox to host", "Safari can't stream a local file yet. Friends can still watch in any browser.", homeButton());
  }
  const form = profileForm();
  const onlyMe = el("label", "toggle");
  const onlyMeBox = el("input");
  onlyMeBox.type = "checkbox";
  onlyMe.append(onlyMeBox, document.createTextNode(" Only I can control playback"));
  const start = el("button", "btn accent", "Start party");
  start.disabled = true;
  const err = el("p", "error");
  let file: File | null = null;
  const picker = filePicker((f) => {
    file = f;
    start.disabled = false;
  });
  start.onclick = async () => {
    if (!file) return;
    start.disabled = true;
    start.textContent = "Starting";
    err.textContent = "";
    try {
      const profile = form.commit();
      const keyText = newKeyText();
      const ref: LocalVideo = { service: "local", name: file.name.slice(0, 200) };
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video: await sealJson(await importKey(keyText), ref) }),
      });
      const body = (await res.json().catch(() => ({}))) as { roomId?: string; hostKey?: string; error?: string };
      if (!res.ok || !body.roomId || !body.hostKey) throw new Error(body.error ?? "Could not start the party.");
      store(`backrow:host:${body.roomId}`, body.hostKey);
      if (onlyMeBox.checked) store(`backrow:hostonly:${body.roomId}`, "1");
      history.replaceState(null, "", `/watch/${body.roomId}#${keyText}`);
      await video.play().catch(() => undefined);
      await startHost({ roomId: body.roomId, keyText }, profile, body.hostKey);
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : "Could not start the party.";
      start.disabled = false;
      start.textContent = "Start party";
    }
  };
  gateCard.replaceChildren(
    el("span", "label", "Stream from your computer"),
    el("p", "title", "Pick a video"),
    picker,
    ...form.nodes,
    onlyMe,
    start,
    err,
    el("p", "meta", "Keep this tab open while you watch: the video streams from it. Everything is end-to-end encrypted."),
  );
  gate.hidden = false;
}

function resumeHost(party: Party, hostKey: string, media: LocalVideo): void {
  const form = profileForm();
  const start = el("button", "btn accent", "Keep streaming");
  start.disabled = true;
  const picker = filePicker(() => (start.disabled = false));
  start.onclick = async () => {
    start.disabled = true;
    await video.play().catch(() => undefined);
    await startHost(party, form.commit(), hostKey);
  };
  gateCard.replaceChildren(
    el("span", "label", "You're the host"),
    el("p", "title", "Pick the file again to keep streaming"),
    el("p", "meta", `This party was streaming “${media.name}”.`),
    picker,
    ...form.nodes,
    start,
  );
  gate.hidden = false;
}

// ---------------- Viewer ----------------

async function startViewer(party: Party, profile: Profile): Promise<void> {
  gate.hidden = true;
  const client = new PartyClient({ server: location.origin, roomId: party.roomId, keyText: party.keyText, profile });
  const panel = makePanel(client, party, profile, () => viewer.close());
  const ui = new PlayerUI(screen, video, stage, {
    state: () => {
      const st = client.room?.state;
      if (!st) return { playing: false, position: 0, duration: 0 };
      return { playing: st.playing, position: expectedPosition(st, client.serverNow()), duration: st.duration };
    },
    canControl: () => client.canControl,
    toggle: () => {
      const st = client.room?.state;
      if (!st) return;
      void client.sendState({ playing: !st.playing, position: expectedPosition(st, client.serverNow()), rate: st.rate, duration: st.duration });
      panel.noteOwnState({ ...st, playing: !st.playing, at: client.serverNow() });
    },
    seek: (s) => {
      const st = client.room?.state;
      if (!st) return;
      void client.sendState({ playing: st.playing, position: s, rate: st.rate, duration: st.duration });
    },
    resume: () => {
      if (!video.srcObject || !(video.paused || autoMuted)) return false;
      autoMuted = false;
      video.muted = false;
      void video.play().then(() => ui.setStatus(null), () => ui.setStatus("Click to start the video"));
      return true;
    },
  });
  ui.setStatus("Connecting to the host");

  // The stream arrives seconds after the Join click, so browsers may refuse to
  // autoplay it with sound. Fall back to muted playback and ask for a click.
  let autoMuted = false;
  const startPlayback = () =>
    video.play().catch(() => {
      video.muted = true;
      autoMuted = true;
      ui.setStatus("Click for sound");
      return video.play().catch(() => ui.setStatus("Click to start the video"));
    });

  const ice = await loadIceServers();
  const viewer = new StreamViewer(client, ice, (stream) => {
    video.srcObject = stream;
    if (stream) {
      ui.setStatus(null);
      void startPlayback();
    } else {
      ui.setStatus("Reconnecting to the host");
    }
  });
  video.addEventListener("playing", () => !autoMuted && ui.setStatus(null));
  video.addEventListener("volumechange", () => {
    if (autoMuted && !video.muted) {
      autoMuted = false;
      ui.setStatus(null);
    }
  });

  const ask = () => {
    const room = client.room;
    if (!room || viewer.connected) return;
    const hostHere = room.host && room.members.some((m) => m.id === room.host);
    if (hostHere && room.host !== room.you) viewer.request(room.host!);
    else ui.setStatus("Waiting for the host to come back");
  };
  setInterval(ask, 5000);
  client.on((e: PartyEvent) => {
    panel.handle(e);
    if (e.type === "snapshot" || e.type === "host" || (e.type === "member-join" && e.member.id === client.room?.host)) {
      setTimeout(ask, 300);
    } else if (e.type === "member-leave" && e.member.id === client.room?.host) {
      viewer.close();
      video.srcObject = null;
      ui.setStatus("The host left. Waiting for them to come back");
    } else if (e.type === "signal") {
      void viewer.onSignal(e.from, e.data);
    } else if (e.type === "status" && e.status === "closed") {
      gateMessage("Party ended", "This party has ended or the link is no longer valid.", homeButton());
    }
  });
}

function joinGate(party: Party, media: LocalVideo, members: number): void {
  const form = profileForm();
  const join = el("button", "btn accent", "Join party");
  join.onclick = () => void startViewer(party, form.commit());
  gateCard.replaceChildren(
    el("span", "label", `Streamed from the host · ${members} watching`),
    el("p", "title", media.name),
    ...form.nodes,
    join,
    el("p", "meta", "The video streams directly from the host's computer. Video and chat are end-to-end encrypted."),
  );
  gate.hidden = false;
  form.focus();
}

// ---------------- Entry ----------------

async function run(): Promise<void> {
  if (location.pathname === "/host") return newHostParty();
  const party = partyFromLocation();
  if (!party) return gateMessage("This link is incomplete", "Ask for the invite link again, including the part after #.", homeButton());
  const res = await fetch(`/api/rooms/${party.roomId}`);
  if (res.status === 404) return gateMessage("This party has ended", "Parties close a few hours after everyone leaves.", homeButton());
  if (!res.ok) return gateMessage("Could not open the party", "Check your connection and reload.");
  const info = (await res.json()) as { video: string; members: number };
  const media = parseVideo(await openJson(await importKey(party.keyText), info.video));
  if (!media) return gateMessage("This link doesn't open", "The key in the link is wrong or was cut off.", homeButton());
  if (media.service !== "local") {
    location.replace(`/p/${party.roomId}#${party.keyText}`);
    return;
  }
  const hostKey = load(`backrow:host:${party.roomId}`);
  if (hostKey) return resumeHost(party, hostKey, media);
  joinGate(party, media, info.members);
}

run().catch((err) => {
  console.error("[backrow] watch failed", err);
  gateMessage("Something went wrong", err instanceof Error ? err.message : "Reload the page to try again.");
});
