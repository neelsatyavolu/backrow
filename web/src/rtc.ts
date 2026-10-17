// Peer-to-peer streaming of the host's local file. The host's browser plays the
// file and compresses it live (hardware H.264 where available), sending one
// WebRTC stream to each viewer. Setup messages travel through the party's
// end-to-end encrypted channel, so the server can't swap in its own keys, and
// the media itself is encrypted between browsers by WebRTC (DTLS-SRTP).

import type { PartyClient } from "../../shared/party-client";

type Signal =
  | { kind: "want" }
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string };

const VIDEO_BITRATE = 8_000_000;
const AUDIO_BITRATE = 192_000;
/** Extra viewer-side buffering: a little more latency for much smoother playback. */
const JITTER_TARGET_MS = 400;

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
  if ((d.kind === "offer" || d.kind === "answer") && typeof d.sdp === "string" && d.sdp.length < 11000) return { kind: d.kind, sdp: d.sdp };
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

  constructor(
    private readonly client: PartyClient,
    private readonly stream: MediaStream,
    private readonly ice: RTCIceServer[],
  ) {
    for (const track of stream.getVideoTracks()) track.contentHint = "motion";
  }

  get viewers(): number {
    return [...this.peers.values()].filter((pc) => pc.connectionState === "connected").length;
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
    for (const track of this.stream.getTracks()) {
      const transceiver = pc.addTransceiver(track, { direction: "sendonly", streams: [this.stream] });
      if (track.kind === "video") preferCodecs(transceiver);
      const params = transceiver.sender.getParameters();
      params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: track.kind === "video" ? VIDEO_BITRATE : AUDIO_BITRATE }];
      if (track.kind === "video") params.degradationPreference = "balanced";
      transceiver.sender.setParameters(params).catch(() => undefined);
    }
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
    void this.client.sendSignal(hostId, { kind: "want" });
  }

  async onSignal(from: string, data: unknown): Promise<void> {
    const signal = parseSignal(data);
    if (signal?.kind !== "offer") return;
    this.close();
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    this.pc = pc;
    pc.addEventListener("track", (e) => {
      const receiver = e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null };
      if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = JITTER_TARGET_MS;
      this.onStream(e.streams[0] ?? new MediaStream([e.track]));
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
