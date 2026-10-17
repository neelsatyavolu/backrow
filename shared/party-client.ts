// Connection to one party room. Encrypts everything it sends, decrypts and
// validates everything it receives, and keeps a plaintext mirror of the room.

import { importKey, openJson, sealJson } from "./crypto";
import {
  parseChat,
  parseProfile,
  parseReaction,
  parseState,
  parseVideo,
  type PlaybackState,
  type Profile,
} from "./payload";
import type { ClientMessage, ControlMode, ServerMessage, WireChat, WireMember } from "./protocol";
import type { VideoRef } from "./services";
import { ClockSync } from "./sync";

export interface Member extends Profile {
  id: string;
}

export interface ChatEntry {
  id: string;
  from: string;
  name: string;
  color: number;
  photo?: string;
  text: string;
  at: number;
}

export interface RoomSnapshot {
  you: string;
  host: string | null;
  control: ControlMode;
  members: Member[];
  state: (PlaybackState & { by: string }) | null;
  video: VideoRef | null;
  chat: ChatEntry[];
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export type PartyEvent =
  | { type: "status"; status: ConnectionStatus }
  | { type: "snapshot"; snapshot: RoomSnapshot }
  | { type: "member-join"; member: Member }
  | { type: "member-leave"; member: Member }
  | { type: "member-update"; member: Member }
  | { type: "state"; state: PlaybackState; by: Member }
  | { type: "video"; video: VideoRef; by: Member }
  | { type: "chat"; entry: ChatEntry }
  | { type: "react"; emoji: string; from: Member }
  | { type: "typing"; member: Member; on: boolean }
  | { type: "control"; mode: ControlMode }
  | { type: "host"; id: string | null }
  | { type: "error"; code: string; message: string };

export interface PartyClientOptions {
  server: string;
  roomId: string;
  keyText: string;
  hostKey?: string;
  profile: Profile;
  WebSocketImpl?: typeof WebSocket;
}

const UNKNOWN: Profile = { name: "Someone", color: 7 };
const PING_MS = 15000;

export class PartyClient {
  readonly clock = new ClockSync();
  private key: Promise<CryptoKey>;
  private ws: WebSocket | null = null;
  private listeners = new Set<(e: PartyEvent) => void>();
  private snapshot: RoomSnapshot | null = null;
  private status: ConnectionStatus = "connecting";
  private closedByUser = false;
  private retry = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inbox: Promise<void> = Promise.resolve();
  private profile: Profile;

  constructor(private readonly opts: PartyClientOptions) {
    this.key = importKey(opts.keyText);
    this.profile = opts.profile;
    this.connect();
  }

  get room(): RoomSnapshot | null {
    return this.snapshot;
  }

  get connection(): ConnectionStatus {
    return this.status;
  }

  get canControl(): boolean {
    const s = this.snapshot;
    return !!s && (s.control === "everyone" || s.host === s.you);
  }

  on(listener: (e: PartyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  serverNow(): number {
    return this.clock.serverNow();
  }

  async sendState(state: Omit<PlaybackState, "at">): Promise<void> {
    if (!this.snapshot || !this.canControl) return;
    const full: PlaybackState = { ...state, at: this.serverNow() };
    this.snapshot = { ...this.snapshot, state: { ...full, by: this.snapshot.you } };
    this.send({ t: "state", blob: await sealJson(await this.key, full) });
  }

  async sendVideo(video: VideoRef): Promise<void> {
    if (!this.snapshot || !this.canControl) return;
    this.snapshot = { ...this.snapshot, video, state: null };
    this.send({ t: "video", blob: await sealJson(await this.key, video) });
  }

  async sendChat(text: string): Promise<void> {
    const chat = parseChat({ text });
    if (chat) this.send({ t: "chat", blob: await sealJson(await this.key, chat) });
  }

  async sendReaction(emoji: string): Promise<void> {
    const reaction = parseReaction({ emoji });
    if (reaction) this.send({ t: "react", blob: await sealJson(await this.key, reaction) });
  }

  setTyping(on: boolean): void {
    this.send({ t: "typing", on });
  }

  async setProfile(profile: Profile): Promise<void> {
    this.profile = profile;
    this.send({ t: "profile", profile: await sealJson(await this.key, profile) });
  }

  setControl(mode: ControlMode): void {
    this.send({ t: "control", mode });
  }

  close(): void {
    this.closedByUser = true;
    this.stopTimers();
    this.ws?.close(1000, "left");
    this.setStatus("closed");
  }

  // ---- internals ----

  private emit(e: PartyEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error("[backrow] listener failed", err);
      }
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.emit({ type: "status", status });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }

  private connect(): void {
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const url = new URL(`/ws/${this.opts.roomId}`, this.opts.server);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    const ws = new Impl(url.toString());
    this.ws = ws;

    ws.onopen = async () => {
      this.retry = 0;
      const profile = await sealJson(await this.key, this.profile);
      const hello: ClientMessage = this.opts.hostKey
        ? { t: "hello", profile, hostKey: this.opts.hostKey }
        : { t: "hello", profile };
      this.send(hello);
      this.ping();
      setTimeout(() => this.ping(), 400);
      setTimeout(() => this.ping(), 1200);
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      // Decrypt in arrival order so chat and state never reorder.
      this.inbox = this.inbox.then(() => this.receive(data)).catch((err) => console.error("[backrow] bad frame", err));
    };
    ws.onclose = (ev) => {
      this.stopTimers();
      if (this.ws !== ws) return;
      if (this.closedByUser || ev.code === 4404) {
        this.setStatus("closed");
        return;
      }
      this.setStatus("reconnecting");
      const delay = Math.min(30000, 500 * 2 ** this.retry++) + Math.random() * 300;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private ping(): void {
    this.send({ t: "ping", c: Date.now() });
  }

  private member(id: string): Member {
    return this.snapshot?.members.find((m) => m.id === id) ?? { id, ...UNKNOWN };
  }

  private async decodeMember(w: WireMember): Promise<Member> {
    const profile = parseProfile(await openJson(await this.key, w.profile)) ?? UNKNOWN;
    return { id: w.id, ...profile };
  }

  private async decodeChat(w: WireChat, members: Member[]): Promise<ChatEntry | null> {
    const chat = parseChat(await openJson(await this.key, w.blob));
    if (!chat) return null;
    const who = members.find((m) => m.id === w.from) ?? { id: w.from, ...UNKNOWN };
    return { id: w.id, from: w.from, name: who.name, color: who.color, photo: who.photo, text: chat.text, at: w.at };
  }

  private async receive(raw: string): Promise<void> {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    const key = await this.key;

    if (msg.t === "pong") {
      this.clock.add(msg.c, msg.s, Date.now());
      return;
    }
    if (msg.t === "welcome") {
      this.clock.add(Date.now(), msg.serverTime, Date.now());
      const members = await Promise.all(msg.members.map((m) => this.decodeMember(m)));
      const chat = (await Promise.all(msg.chat.map((c) => this.decodeChat(c, members)))).filter(
        (c): c is ChatEntry => c !== null,
      );
      const video = parseVideo(await openJson(key, msg.video));
      const state = msg.state ? parseState(await openJson(key, msg.state.blob)) : null;
      this.snapshot = {
        you: msg.you,
        host: msg.host,
        control: msg.control,
        members,
        chat,
        video,
        state: state && msg.state ? { ...state, by: msg.state.by } : null,
      };
      this.setStatus("open");
      this.emit({ type: "snapshot", snapshot: this.snapshot });
      return;
    }
    if (msg.t === "error") {
      this.emit({ type: "error", code: msg.code, message: msg.message });
      return;
    }
    const snap = this.snapshot;
    if (!snap) return;

    switch (msg.t) {
      case "join": {
        const member = await this.decodeMember(msg.member);
        this.snapshot = { ...snap, members: [...snap.members.filter((m) => m.id !== member.id), member] };
        this.emit({ type: "member-join", member });
        break;
      }
      case "leave": {
        const member = this.member(msg.id);
        this.snapshot = { ...snap, members: snap.members.filter((m) => m.id !== msg.id) };
        this.emit({ type: "member-leave", member });
        break;
      }
      case "profile": {
        const member = await this.decodeMember({ id: msg.id, profile: msg.profile });
        this.snapshot = { ...snap, members: snap.members.map((m) => (m.id === member.id ? member : m)) };
        this.emit({ type: "member-update", member });
        break;
      }
      case "state": {
        const state = parseState(await openJson(key, msg.blob));
        if (!state || msg.by === snap.you) break;
        this.snapshot = { ...snap, state: { ...state, by: msg.by } };
        this.emit({ type: "state", state, by: this.member(msg.by) });
        break;
      }
      case "video": {
        const video = parseVideo(await openJson(key, msg.blob));
        if (!video || msg.by === snap.you) break;
        this.snapshot = { ...snap, video, state: null };
        this.emit({ type: "video", video, by: this.member(msg.by) });
        break;
      }
      case "chat": {
        const entry = await this.decodeChat(msg.entry, snap.members);
        if (!entry) break;
        this.snapshot = { ...snap, chat: [...snap.chat, entry].slice(-150) };
        this.emit({ type: "chat", entry });
        break;
      }
      case "react": {
        const reaction = parseReaction(await openJson(key, msg.blob));
        if (reaction) this.emit({ type: "react", emoji: reaction.emoji, from: this.member(msg.from) });
        break;
      }
      case "typing":
        if (msg.id !== snap.you) this.emit({ type: "typing", member: this.member(msg.id), on: msg.on });
        break;
      case "control":
        this.snapshot = { ...snap, control: msg.mode };
        this.emit({ type: "control", mode: msg.mode });
        break;
      case "host":
        this.snapshot = { ...snap, host: msg.id };
        this.emit({ type: "host", id: msg.id });
        break;
    }
  }
}
