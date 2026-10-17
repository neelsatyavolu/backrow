// Peer-to-peer streaming of the host's local file. The host's browser plays the
// file and compresses it live (hardware H.264 where available), sending one
// WebRTC stream to each viewer. Setup messages travel through the party's
// end-to-end encrypted channel, so the server can't swap in its own keys, and
// the media itself is encrypted between browsers by WebRTC (DTLS-SRTP).

import { MAX_CAPTION_BYTES } from "../../shared/captions";
import type { PartyClient } from "../../shared/party-client";
import type { RemoteLog } from "../../shared/remote-log";

type Signal =
  | { kind: "want" }
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string };

const VIDEO_BITRATE = 8_000_000;
const AUDIO_BITRATE = 192_000;
/** Extra viewer-side buffering: a little more latency for much smoother playback. */
const JITTER_TARGET_MS = 400;
/**
 * Captions ride a data channel on the same connection, as a header
 * {"parts": n} followed by n pieces of the caption file (0 parts clears them).
 * Pieces stay well under every browser's message size limit.
 */
const CAPTIONS_CHANNEL = "captions";
const CAPTION_CHUNK = 16_000;
const MAX_CAPTION_PARTS = Math.ceil(MAX_CAPTION_BYTES / CAPTION_CHUNK);

function sendCaptions(channel: RTCDataChannel, text: string | null): void {
  const parts: string[] = [];
  for (let i = 0; text && i < text.length; i += CAPTION_CHUNK) parts.push(text.slice(i, i + CAPTION_CHUNK));
  channel.send(JSON.stringify({ parts: parts.length }));
  for (const part of parts) channel.send(part);
}

/** Reassembles caption files sent with sendCaptions; bad input is dropped. */
function receiveCaptions(channel: RTCDataChannel, onCaptions: (text: string | null) => void): void {
  let expected = 0;
  let parts: string[] = [];
  channel.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    if (expected > 0) {
      parts.push(e.data);
      if (parts.length === expected) {
        expected = 0;
        onCaptions(parts.join(""));
        parts = [];
      }
      return;
    }
    let header: unknown;
    try {
      header = JSON.parse(e.data);
    } catch {
      return;
    }
    const n = (header as { parts?: unknown } | null)?.parts;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_CAPTION_PARTS) return;
    if (n === 0) onCaptions(null);
    expected = n;
    parts = [];
  });
}

export async function loadIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch("/api/ice");
    const body = (await res.json()) as { iceServers?: RTCIceServer[] };
    return body.iceServers?.length ? body.iceServers : [{ urls: "stun:stun.cloudflare.com:3478" }];
  } catch {
    return [{ urls: "stun:stun.cloudflare.com:3478" }];
  }
}

function parseSignal(data: unknown): Signal | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.kind === "want") return { kind: "want" };
  if ((d.kind === "offer" || d.kind === "answer") && typeof d.sdp === "string" && d.sdp.length < 34000) return { kind: d.kind, sdp: d.sdp };
  return null;
}

/** Stereo, higher-bitrate Opus: movie audio deserves more than voice-call defaults. */
function richAudio(sdp: string): string {
  const opus = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
  if (!opus) return sdp;
  // [^\r\n]* keeps the insertion before the line's \r\n ending.
  return sdp.replace(new RegExp(`a=fmtp:${opus} ([^\r\n]*)`), (_m, params: string) =>
    `a=fmtp:${opus} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=${AUDIO_BITRATE}`,
  );
}

/** Waits for ICE gathering so one offer/answer carries every candidate. */
function gathered(pc: RTCPeerConnection, timeoutMs = 2500): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

const STATS_MS = 10_000;

type Stat = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** Average jitter buffer wait (ms) of one inbound track since the previous sample. */
function bufferMs(now: Stat | undefined, before: Stat | undefined): number | null {
  const emitted = num(now?.jitterBufferEmittedCount) - num(before?.jitterBufferEmittedCount);
  return emitted > 0 ? Math.round((1000 * (num(now?.jitterBufferDelay) - num(before?.jitterBufferDelay))) / emitted) : null;
}

/**
 * Viewer-side A/V sync: how long each track waits in its buffer, and the gap
 * between the two tracks' estimated playout timestamps (video minus audio, ms;
 * excludes the output device's own delay). Compare it across sessions rather
 * than reading it as an absolute offset.
 */
function syncStats(audio: Stat | undefined, video: Stat | undefined, prev: Map<string, Stat>) {
  const playout = (s: Stat | undefined) => (typeof s?.estimatedPlayoutTimestamp === "number" ? s.estimatedPlayoutTimestamp : null);
  const a = playout(audio);
  const v = playout(video);
  return {
    audioBufMs: bufferMs(audio, prev.get("audio")),
    videoBufMs: bufferMs(video, prev.get("video")),
    playoutGapMs: a !== null && v !== null ? Math.round(v - a) : null,
    audioLost: audio?.packetsLost ?? null,
    audioConcealed: audio ? Math.round((1000 * num(audio.concealedSamples)) / Math.max(1, num(audio.totalSamplesReceived))) / 10 : null,
  };
}

/**
 * Logs a connection's state changes, which route it picked (host = direct,
 * srflx = through NAT, relay = TURN) and, while it is up, how much video moves.
 */
function watchConnection(pc: RTCPeerConnection, peer: string, log: RemoteLog): void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let prev = new Map<string, Stat>();
  const stats = async () => {
    const report = await pc.getStats().catch(() => null);
    if (!report) return;
    const all = [...report.values()] as Stat[];
    const pair = all.find((r) => r.type === "candidate-pair" && r.nominated && r.state === "succeeded");
    const kind = (id: unknown) => all.find((r) => r.id === id)?.candidateType;
    const video = all.find((r) => (r.type === "inbound-rtp" || r.type === "outbound-rtp") && r.kind === "video");
    const inbound = new Map(all.filter((r) => r.type === "inbound-rtp").map((r) => [String(r.kind), r]));
    log("rtc stats", {
      peer,
      route: pair ? `${kind(pair.localCandidateId)}->${kind(pair.remoteCandidateId)}` : null,
      rttMs: typeof pair?.currentRoundTripTime === "number" ? Math.round(pair.currentRoundTripTime * 1000) : null,
      frames: video?.framesDecoded ?? video?.framesEncoded ?? null,
      bytes: video?.bytesReceived ?? video?.bytesSent ?? null,
      size: video ? `${video.frameWidth ?? "?"}x${video.frameHeight ?? "?"}` : null,
      ...(inbound.size ? syncStats(inbound.get("audio"), inbound.get("video"), prev) : {}),
    });
    prev = inbound;
  };
  pc.addEventListener("iceconnectionstatechange", () => log("ice state", { peer, state: pc.iceConnectionState }));
  pc.addEventListener("connectionstatechange", () => {
    log("rtc state", { peer, state: pc.connectionState });
    if (pc.connectionState === "connected") {
      void stats();
      timer ??= setInterval(() => void stats(), STATS_MS);
    } else if (timer && (pc.connectionState === "failed" || pc.connectionState === "closed")) {
      clearInterval(timer);
      timer = null;
    }
  });
}

function preferCodecs(transceiver: RTCRtpTransceiver): void {
  const caps = RTCRtpSender.getCapabilities?.("video");
  if (!caps || !transceiver.setCodecPreferences) return;
  const rank = (mime: string) => ["video/h264", "video/vp9", "video/av1", "video/vp8"].indexOf(mime.toLowerCase());
  const sorted = [...caps.codecs].sort((a, b) => {
    const ra = rank(a.mimeType);
    const rb = rank(b.mimeType);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  });
  try {
    transceiver.setCodecPreferences(sorted);
  } catch {
    // Keep the browser's defaults.
  }
}

/** Host side: one connection per viewer, each fed from the local <video>. */
/** How long a connection may stay in setup before a new request replaces it. */
const SETUP_GRACE_MS = 10_000;

export class StreamHost {
  private peers = new Map<string, RTCPeerConnection>();
  private started = new Map<string, number>();
  private channels = new Map<string, RTCDataChannel>();
  private captions: string | null = null;

  constructor(
    private readonly client: PartyClient,
    private readonly stream: MediaStream,
    private readonly ice: RTCIceServer[],
    private readonly log: RemoteLog = () => undefined,
  ) {
    for (const track of stream.getVideoTracks()) track.contentHint = "motion";
  }

  get viewers(): number {
    return [...this.peers.values()].filter((pc) => pc.connectionState === "connected").length;
  }

  /** Sends the caption file (or null for none) to every viewer, now and later. */
  setCaptions(text: string | null): void {
    this.captions = text;
    for (const channel of this.channels.values()) {
      if (channel.readyState === "open") sendCaptions(channel, text);
    }
  }

  async onSignal(from: string, data: unknown): Promise<void> {
    const signal = parseSignal(data);
    if (signal?.kind === "want") {
      // Repeat requests while a connection is up or still being set up are ignored.
      const pc = this.peers.get(from);
      const age = Date.now() - (this.started.get(from) ?? 0);
      if (pc && (pc.connectionState === "connected" || age < SETUP_GRACE_MS)) return;
      await this.offer(from);
    }
    else if (signal?.kind === "answer") await this.peers.get(from)?.setRemoteDescription({ type: "answer", sdp: signal.sdp });
  }

  private async offer(to: string): Promise<void> {
    this.close(to);
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    this.peers.set(to, pc);
    this.started.set(to, Date.now());
    this.log("offer", { to, tracks: this.stream.getTracks().map((t) => `${t.kind}:${t.readyState}`) });
    watchConnection(pc, to, this.log);
    for (const track of this.stream.getTracks()) {
      const transceiver = pc.addTransceiver(track, { direction: "sendonly", streams: [this.stream] });
      if (track.kind === "video") preferCodecs(transceiver);
      const params = transceiver.sender.getParameters();
      params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: track.kind === "video" ? VIDEO_BITRATE : AUDIO_BITRATE }];
      if (track.kind === "video") params.degradationPreference = "balanced";
      transceiver.sender.setParameters(params).catch(() => undefined);
    }
    const channel = pc.createDataChannel(CAPTIONS_CHANNEL);
    channel.addEventListener("open", () => this.captions && sendCaptions(channel, this.captions));
    this.channels.set(to, channel);
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.close(to);
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription({ type: "offer", sdp: richAudio(offer.sdp ?? "") });
    await gathered(pc);
    if (this.peers.get(to) === pc && pc.localDescription) await this.client.sendSignal(to, { kind: "offer", sdp: pc.localDescription.sdp });
  }

  close(id: string): void {
    this.peers.get(id)?.close();
    this.peers.delete(id);
    this.started.delete(id);
    this.channels.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.peers.keys()]) this.close(id);
  }
}

/** Viewer side: asks the host for the stream and answers its offer. */
export class StreamViewer {
  private pc: RTCPeerConnection | null = null;
  private askedAt = 0;

  constructor(
    private readonly client: PartyClient,
    private readonly ice: RTCIceServer[],
    private readonly onStream: (stream: MediaStream | null) => void,
    private readonly onCaptions: (text: string | null) => void,
    private readonly log: RemoteLog = () => undefined,
  ) {}

  get connected(): boolean {
    return this.pc?.connectionState === "connected";
  }

  /** Asks the host for the stream, unless a connection is already up or being set up. */
  request(hostId: string): void {
    const state = this.pc?.connectionState;
    if (state === "connected" || state === "connecting" || state === "new") return;
    if (Date.now() - this.askedAt < SETUP_GRACE_MS) return;
    this.askedAt = Date.now();
    this.log("want", { host: hostId, state: state ?? null });
    void this.client.sendSignal(hostId, { kind: "want" });
  }

  async onSignal(from: string, data: unknown): Promise<void> {
    const signal = parseSignal(data);
    if (signal?.kind !== "offer") return;
    this.close();
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    this.pc = pc;
    watchConnection(pc, from, this.log);
    pc.addEventListener("track", (e) => {
      const receiver = e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null };
      this.log("track", { kind: e.track.kind, muted: e.track.muted });
      if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = JITTER_TARGET_MS;
      this.onStream(e.streams[0] ?? new MediaStream([e.track]));
    });
    pc.addEventListener("datachannel", (e) => {
      if (e.channel.label === CAPTIONS_CHANNEL) receiveCaptions(e.channel, (text) => this.pc === pc && this.onCaptions(text));
    });
    pc.addEventListener("connectionstatechange", () => {
      if (this.pc === pc && (pc.connectionState === "failed" || pc.connectionState === "closed")) {
        this.pc = null;
        this.askedAt = 0;
        this.onStream(null);
      }
    });
    await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription({ type: "answer", sdp: richAudio(answer.sdp ?? "") });
    await gathered(pc);
    if (this.pc === pc && pc.localDescription) await this.client.sendSignal(from, { kind: "answer", sdp: pc.localDescription.sdp });
  }

  close(): void {
    this.pc?.close();
    this.pc = null;
    this.askedAt = 0;
  }
}
