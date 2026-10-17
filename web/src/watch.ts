// Watch parties for a file on the host's computer. Nothing is uploaded: the
// host's browser plays the file and streams it peer-to-peer to each viewer
// (rtc.ts). Chat, names and controls use the same encrypted party as the
// extension.

import { decodeCaptions, MAX_CAPTION_BYTES, parseCaptions } from "../../shared/captions";
import { importKey, newKeyText, openJson, sealJson } from "../../shared/crypto";
import { PartyClient, type PartyEvent } from "../../shared/party-client";
import { parseVideo, type Profile } from "../../shared/payload";
import { remoteLog, type RemoteLog } from "../../shared/remote-log";
import type { LocalVideo } from "../../shared/services";
import { expectedPosition } from "../../shared/sync";
import { SyncController, type PlayerAdapter, type PlayerEvent } from "../../shared/sync-controller";
import { ChatPanel } from "../../shared/ui/panel";
import { el, load, partyFromLocation, pullAccountProfile, saveProfile, store } from "./local";
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

// "Send debug logs" in the extension's settings, passed on by its page script.
let remote: RemoteLog | null = null;
const debug: RemoteLog = (msg, data) => remote?.(msg, data);
const enableLog = () => {
  remote ??= remoteLog(location.origin, `web:${location.pathname.split("/")[1] || "home"}`);
  remote("log on", { ua: navigator.userAgent });
};
if (document.documentElement.dataset.backrowRemoteLog === "1") enableLog();
document.addEventListener("backrow:remote-log", enableLog);

/** Summary of the ICE servers, without credentials. */
const iceKinds = (ice: RTCIceServer[]) => ice.flatMap((s) => [s.urls].flat().map((u) => u.split(":")[0]));

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

/**
 * Chrome stamps an element's captured audio as if it played earlier than it
 * does, so once WebRTC's lip sync settled, viewers heard the sound ~0.5 s
 * before the picture. Passing the audio through Web Audio gives it fresh
 * timestamps, and holding it back 320 ms lines it up (measured against a real
 * film: +510 ms before, within a frame after). Lip sync ignores the viewer's own
 * speakers or headphones (Bluetooth adds ~200 ms), so each viewer's audio is
 * held back that much less.
 */
const CAPTURE_LEAD_MS = 320;

/** Copies of the audio track, delayed by a given number of ms (in 10 ms steps). */
function audioDelays(track: MediaStreamTrack): (ms: number) => MediaStreamTrack {
  const ctx = new AudioContext({ latencyHint: "playback" });
  const resume = () => void ctx.resume().catch(() => undefined);
  resume();
  // The Start click normally lets it run; if the browser still holds it, the next click does.
  for (const type of ["pointerdown", "keydown"]) addEventListener(type, resume, { once: true });
  ctx.addEventListener("statechange", () => debug("audio delay", { state: ctx.state }));
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const lines = new Map<number, { gain: GainNode; track: MediaStreamTrack }>();
  // Silence what was still in the delays when a seek starts, until new audio comes through.
  video.addEventListener("seeking", () => {
    for (const { gain } of lines.values()) {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime);
    }
  });
  video.addEventListener("seeked", () => {
    for (const [ms, { gain }] of lines) gain.gain.setValueAtTime(1, ctx.currentTime + ms / 1000);
  });
  return (ms) => {
    const key = Math.round(ms / 10) * 10;
    const existing = lines.get(key);
    if (existing) return existing.track;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = key / 1000;
    const gain = ctx.createGain();
    const out = ctx.createMediaStreamDestination();
    source.connect(delay).connect(gain).connect(out);
    const line = { gain, track: out.stream.getAudioTracks()[0]! };
    lines.set(key, line);
    return line.track;
  };
}

/** Captures the local video; the result gives the stream for a viewer whose output adds outputMs. */
function capture(): (outputMs: number) => MediaStream {
  const v = video as CaptureVideo;
  const raw = v.captureStream ? v.captureStream() : v.mozCaptureStream!();
  const audio = raw.getAudioTracks()[0];
  // Only measured on Chrome's captureStream; Firefox's is sent as it comes.
  if (!v.captureStream || !audio) return () => raw;
  const delayed = audioDelays(audio);
  return (outputMs) => new MediaStream([...raw.getVideoTracks(), delayed(Math.max(0, CAPTURE_LEAD_MS - outputMs))]);
}

/** How much this device's speakers or headphones delay sound, in ms; 0 if unknown. */
async function outputDelayMs(): Promise<number> {
  const ctx = new AudioContext();
  try {
    await ctx.resume();
    // Browsers fill outputLatency in shortly after the device starts.
    for (let i = 0; i < 10 && !ctx.outputLatency; i++) await new Promise((r) => setTimeout(r, 100));
    return Math.round((ctx.outputLatency || 0) * 1000);
  } catch {
    return 0;
  } finally {
    void ctx.close();
  }
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

/** Reads a caption file; throws with a message to show when it isn't usable. */
async function readCaptions(file: File): Promise<string> {
  if (file.size > MAX_CAPTION_BYTES) throw new Error("That caption file is too big.");
  const text = decodeCaptions(new Uint8Array(await file.arrayBuffer()));
  if (parseCaptions(text).length === 0) throw new Error("No captions found. Use an .srt or .vtt file.");
  return text;
}

const CAPTION_TYPES = ".srt,.vtt,text/vtt";

/** Optional caption file picker for the host's setup card. */
function captionPicker(onLoad: (text: string | null) => void): HTMLElement {
  const box = el("label", "toggle captions-pick");
  const input = el("input");
  input.type = "file";
  input.accept = CAPTION_TYPES;
  input.hidden = true;
  const name = el("span", "", "+ Add captions (.srt or .vtt, optional)");
  box.append(input, name);
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      onLoad(await readCaptions(file));
      name.textContent = `Captions · ${file.name}`;
    } catch (e) {
      onLoad(null);
      name.textContent = e instanceof Error ? e.message : "Couldn't read that caption file.";
    }
  };
  return box;
}

/** Opens a file dialog for a caption file, from the player's CC button. */
function pickCaptions(onLoad: (text: string) => void, onError: (message: string) => void): void {
  const input = el("input");
  input.type = "file";
  input.accept = CAPTION_TYPES;
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) readCaptions(file).then(onLoad, (e: unknown) => onError(e instanceof Error ? e.message : "Couldn't read that caption file."));
  };
  input.click();
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
      saveProfile(p);
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

async function startHost(party: Party, profile: Profile, hostKey: string, captions: string | null): Promise<void> {
  gate.hidden = true;
  // Before connecting: events that arrive while this loads would be missed.
  const ice = await loadIceServers();
  const client = new PartyClient({ server: location.origin, roomId: party.roomId, keyText: party.keyText, hostKey, profile });
  let streamFor: ((outputMs: number) => MediaStream) | null = null;
  let host: StreamHost | null = null;
  const panel = makePanel(client, party, profile, () => host?.closeAll());
  const sync = new SyncController(localAdapter, {
    debug,
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
    addCaptions: () => pickCaptions(setCaptions, (message) => {
      ui.setStatus(message);
      setTimeout(() => ui.setStatus(null), 2500);
    }),
  };
  const ui = new PlayerUI(screen, video, stage, source);
  const setCaptions = (text: string | null) => {
    captions = text;
    const cues = text ? parseCaptions(text) : [];
    ui.setCaptions(cues);
    host?.setCaptions(text);
    debug("captions", { cues: cues.length });
  };
  setCaptions(captions);

  debug("host ready", { ice: iceKinds(ice) });
  const ensureStream = (): StreamHost => {
    streamFor ??= capture();
    if (!host) {
      host = new StreamHost(client, streamFor, ice, debug);
      host.setCaptions(captions);
    }
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
  let captions: string | null = null;
  const picker = filePicker((f) => {
    file = f;
    start.disabled = false;
  });
  const captionBox = captionPicker((text) => (captions = text));
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
      await startHost({ roomId: body.roomId, keyText }, profile, body.hostKey, captions);
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
    captionBox,
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
  let captions: string | null = null;
  const captionBox = captionPicker((text) => (captions = text));
  start.onclick = async () => {
    start.disabled = true;
    await video.play().catch(() => undefined);
    await startHost(party, form.commit(), hostKey, captions);
  };
  gateCard.replaceChildren(
    el("span", "label", "You're the host"),
    el("p", "title", "Pick the file again to keep streaming"),
    el("p", "meta", `This party was streaming “${media.name}”.`),
    picker,
    captionBox,
    ...form.nodes,
    start,
  );
  gate.hidden = false;
}

// ---------------- Viewer ----------------

async function startViewer(party: Party, profile: Profile): Promise<void> {
  gate.hidden = true;
  // Measured while the Join click still lets audio start; the host makes up for it.
  const outputMs = outputDelayMs();
  void outputMs.then((ms) => debug("audio output", { ms }));
  // Before connecting: events that arrive while this loads would be missed.
  const ice = await loadIceServers();
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
      if (autoMuted) soundOn();
      else void video.play().then(() => ui.setStatus(null), () => ui.setStatus("Click to start the video"));
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
      debug("autoplay blocked, playing muted");
      return video.play().catch((err: unknown) => {
        debug("muted play failed", { err: String(err) });
        ui.setStatus("Click to start the video");
      });
    });
  // Unmuting a stream that started muted can leave its sound out of step with
  // the picture, so the stream is re-attached and starts with sound instead.
  const soundOn = () => {
    autoMuted = false;
    const stream = video.srcObject;
    video.srcObject = null;
    video.muted = false;
    video.srcObject = stream;
    debug("sound on", { reattached: !!stream });
    void video.play().then(() => ui.setStatus(null), () => ui.setStatus("Click to start the video"));
  };

  debug("viewer ready", { ice: iceKinds(ice) });
  const viewer = new StreamViewer(client, ice, (stream) => {
    video.srcObject = stream;
    debug("stream", { on: !!stream });
    if (stream) {
      // Cleared by "playing", once frames actually arrive.
      ui.setStatus("Starting the video");
      void startPlayback();
    } else {
      ui.setStatus("Reconnecting to the host");
    }
  }, (text) => {
    const cues = text ? parseCaptions(text) : [];
    ui.setCaptions(cues);
    debug("captions", { cues: cues.length });
  }, debug);
  for (const type of ["playing", "waiting", "stalled", "resize"]) {
    video.addEventListener(type, () => debug(`video ${type}`, { size: `${video.videoWidth}x${video.videoHeight}`, paused: video.paused, muted: video.muted }));
  }
  video.addEventListener("playing", () => !autoMuted && ui.setStatus(null));
  video.addEventListener("volumechange", () => {
    if (autoMuted && !video.muted) soundOn();
  });

  const ask = () => {
    const room = client.room;
    if (!room || viewer.connected) return;
    const hostHere = room.host && room.members.some((m) => m.id === room.host);
    if (hostHere && room.host !== room.you) void outputMs.then((ms) => viewer.request(room.host!, ms));
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
  // Signed-in people get their latest profile before the forms fill in.
  const pulled = pullAccountProfile();
  if (location.pathname === "/host") return pulled.then(newHostParty);
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
  await pulled;
  const hostKey = load(`backrow:host:${party.roomId}`);
  if (hostKey) return resumeHost(party, hostKey, media);
  joinGate(party, media, info.members);
}

run().catch((err) => {
  console.error("[backrow] watch failed", err);
  gateMessage("Something went wrong", err instanceof Error ? err.message : "Reload the page to try again.");
});
