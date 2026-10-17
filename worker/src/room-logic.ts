// Pure room rules, kept free of Durable Object APIs so they can be unit tested.
// The server never decrypts anything: it relays blobs and enforces who may
// control playback.

import { randomId } from "../../shared/crypto";
import { LIMITS, type ClientMessage, type ControlMode, type ServerMessage, type WireChat } from "../../shared/protocol";

export interface RoomData {
  createdAt: number;
  video: string;
  hostKey: string;
  control: ControlMode;
  host: string | null;
  state: { blob: string; by: string; at: number } | null;
  chat: WireChat[];
}

export interface Conn {
  id: string;
  joinedAt: number;
  /** Encrypted profile; null until the hello arrives. */
  profile: string | null;
  ownsHostKey: boolean;
}

/** Who receives a message: a group, or one member by id. */
export type Target = "self" | "others" | "all" | { member: string };
export interface Out {
  to: Target;
  msg: ServerMessage;
}

export interface Result {
  room: RoomData;
  conn: Conn;
  out: Out[];
}

export function newRoom(video: string, now: number): RoomData {
  return {
    createdAt: now,
    video,
    hostKey: randomId(24),
    control: "everyone",
    host: null,
    state: null,
    chat: [],
  };
}

export function welcome(room: RoomData, conn: Conn, members: Conn[], now: number): ServerMessage {
  return {
    t: "welcome",
    you: conn.id,
    host: room.host,
    control: room.control,
    members: members.filter((m) => m.profile).map((m) => ({ id: m.id, profile: m.profile! })),
    state: room.state,
    video: room.video,
    chat: room.chat,
    serverTime: now,
  };
}

function error(code: string, message: string): Out {
  return { to: "self", msg: { t: "error", code, message } };
}

/** Earliest-joined member gets the host role when the key holder is away. */
function pickHost(members: Conn[]): string | null {
  const joined = members.filter((m) => m.profile);
  const keyHolder = joined.find((m) => m.ownsHostKey);
  if (keyHolder) return keyHolder.id;
  const first = [...joined].sort((a, b) => a.joinedAt - b.joinedAt)[0];
  return first ? first.id : null;
}

/**
 * Applies one client message. `others` excludes `conn`.
 */
export function handle(room: RoomData, conn: Conn, msg: ClientMessage, others: Conn[], now: number): Result {
  const same = (out: Out[]): Result => ({ room, conn, out });

  if (conn.profile === null && msg.t !== "hello" && msg.t !== "ping") {
    return same([error("hello-first", "Say hello first")]);
  }

  switch (msg.t) {
    case "hello": {
      if (conn.profile !== null) return same([error("already-joined", "Already joined")]);
      const next: Conn = { ...conn, profile: msg.profile, ownsHostKey: msg.hostKey === room.hostKey };
      const everyone = [...others, next];
      const host = pickHost(everyone);
      const nextRoom = host === room.host ? room : { ...room, host };
      const out: Out[] = [
        { to: "self", msg: welcome(nextRoom, next, everyone, now) },
        { to: "others", msg: { t: "join", member: { id: next.id, profile: msg.profile } } },
      ];
      if (host !== room.host) out.push({ to: "others", msg: { t: "host", id: host } });
      return { room: nextRoom, conn: next, out };
    }
    case "state": {
      if (!mayControl(room, conn)) {
        const fix: Out[] = room.state ? [{ to: "self", msg: { t: "state", ...room.state } }] : [];
        return same([error("host-only", "Only the host can control playback"), ...fix]);
      }
      const state = { blob: msg.blob, by: conn.id, at: now };
      return { room: { ...room, state }, conn, out: [{ to: "others", msg: { t: "state", ...state } }] };
    }
    case "video": {
      if (!mayControl(room, conn)) return same([error("host-only", "Only the host can change the video")]);
      return {
        room: { ...room, video: msg.blob, state: null },
        conn,
        out: [{ to: "others", msg: { t: "video", blob: msg.blob, by: conn.id } }],
      };
    }
    case "chat": {
      const entry: WireChat = { id: randomId(10), from: conn.id, blob: msg.blob, at: now };
      const chat = [...room.chat, entry].slice(-LIMITS.history);
      return { room: { ...room, chat }, conn, out: [{ to: "all", msg: { t: "chat", entry } }] };
    }
    case "react":
      return same([{ to: "all", msg: { t: "react", from: conn.id, blob: msg.blob } }]);
    case "typing":
      return same([{ to: "others", msg: { t: "typing", id: conn.id, on: msg.on } }]);
    case "profile":
      return {
        room,
        conn: { ...conn, profile: msg.profile },
        out: [{ to: "others", msg: { t: "profile", id: conn.id, profile: msg.profile } }],
      };
    case "control": {
      if (room.host !== conn.id) return same([error("host-only", "Only the host can change who controls playback")]);
      return { room: { ...room, control: msg.mode }, conn, out: [{ to: "all", msg: { t: "control", mode: msg.mode } }] };
    }
    case "ping":
      return same([{ to: "self", msg: { t: "pong", c: msg.c, s: now } }]);
    case "resync":
      return same([{ to: "self", msg: welcome(room, conn, [...others, conn], now) }]);
    case "signal": {
      if (msg.to === conn.id || !others.some((m) => m.id === msg.to && m.profile)) return same([]);
      return same([{ to: { member: msg.to }, msg: { t: "signal", from: conn.id, blob: msg.blob } }]);
    }
  }
}

export function mayControl(room: RoomData, conn: Conn): boolean {
  return room.control === "everyone" || room.host === conn.id;
}

/** A member disconnected. `remaining` excludes them. */
export function leave(room: RoomData, gone: Conn, remaining: Conn[]): { room: RoomData; out: Out[] } {
  if (gone.profile === null) return { room, out: [] };
  const out: Out[] = [{ to: "all", msg: { t: "leave", id: gone.id } }];
  if (room.host !== gone.id) return { room, out };
  const host = pickHost(remaining);
  return { room: { ...room, host }, out: [...out, { to: "all", msg: { t: "host", id: host } }] };
}

export interface Bucket {
  tokens: number;
  updated: number;
}

/** Token bucket: `rate` messages per second sustained, bursts up to `burst`. */
export function takeToken(bucket: Bucket | undefined, now: number, rate = 8, burst = 30): { ok: boolean; bucket: Bucket } {
  const prev = bucket ?? { tokens: burst, updated: now };
  const tokens = Math.min(burst, prev.tokens + ((now - prev.updated) / 1000) * rate);
  return tokens >= 1
    ? { ok: true, bucket: { tokens: tokens - 1, updated: now } }
    : { ok: false, bucket: { tokens, updated: now } };
}
