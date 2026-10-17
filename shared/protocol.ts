// Wire protocol between clients and the room server. Everything a person
// typed or watched travels as an opaque encrypted `blob`; the server can only
// see member ids, timing and the control mode.

export type ControlMode = "everyone" | "host";

export const LIMITS = {
  blob: 6000,
  /** Profiles can carry a small photo, so they get more room than other blobs. */
  profile: 12000,
  /** WebRTC offers/answers carry a full SDP. */
  signal: 12000,
  frame: 16000,
  history: 150,
  members: 50,
} as const;

export interface WireMember {
  id: string;
  profile: string;
}

export interface WireChat {
  id: string;
  from: string;
  blob: string;
  at: number;
}

export type ClientMessage =
  | { t: "hello"; profile: string; hostKey?: string }
  | { t: "state"; blob: string }
  | { t: "video"; blob: string }
  | { t: "chat"; blob: string }
  | { t: "react"; blob: string }
  | { t: "profile"; profile: string }
  | { t: "typing"; on: boolean }
  | { t: "control"; mode: ControlMode }
  | { t: "ping"; c: number }
  | { t: "resync" }
  /** Encrypted WebRTC setup for one member; the server only routes it. */
  | { t: "signal"; to: string; blob: string };

export type ServerMessage =
  | {
      t: "welcome";
      you: string;
      host: string | null;
      control: ControlMode;
      members: WireMember[];
      state: { blob: string; by: string; at: number } | null;
      video: string;
      chat: WireChat[];
      serverTime: number;
    }
  | { t: "join"; member: WireMember }
  | { t: "leave"; id: string }
  | { t: "profile"; id: string; profile: string }
  | { t: "state"; blob: string; by: string; at: number }
  | { t: "video"; blob: string; by: string }
  | { t: "chat"; entry: WireChat }
  | { t: "react"; from: string; blob: string }
  | { t: "typing"; id: string; on: boolean }
  | { t: "control"; mode: ControlMode }
  | { t: "host"; id: string | null }
  | { t: "pong"; c: number; s: number }
  | { t: "signal"; from: string; blob: string }
  | { t: "error"; code: string; message: string };

const BLOB_RE = /^[A-Za-z0-9_-]+$/;

export function isBlob(value: unknown, max: number = LIMITS.blob): value is string {
  return typeof value === "string" && value.length > 16 && value.length <= max && BLOB_RE.test(value);
}

/** Validates an untrusted client frame. Returns null for anything malformed. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > LIMITS.frame) return null;
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    m = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (m.t) {
    case "hello": {
      if (!isBlob(m.profile, LIMITS.profile)) return null;
      if (m.hostKey !== undefined && (typeof m.hostKey !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(m.hostKey))) return null;
      return m.hostKey ? { t: "hello", profile: m.profile, hostKey: m.hostKey } : { t: "hello", profile: m.profile };
    }
    case "state":
    case "video":
    case "chat":
    case "react":
      return isBlob(m.blob) ? { t: m.t, blob: m.blob } : null;
    case "profile":
      return isBlob(m.profile, LIMITS.profile) ? { t: "profile", profile: m.profile } : null;
    case "typing":
      return typeof m.on === "boolean" ? { t: "typing", on: m.on } : null;
    case "control":
      return m.mode === "everyone" || m.mode === "host" ? { t: "control", mode: m.mode } : null;
    case "ping":
      return typeof m.c === "number" && Number.isFinite(m.c) ? { t: "ping", c: m.c } : null;
    case "resync":
      return { t: "resync" };
    case "signal":
      return typeof m.to === "string" && /^[a-z2-9]{8}$/.test(m.to) && isBlob(m.blob, LIMITS.signal)
        ? { t: "signal", to: m.to, blob: m.blob }
        : null;
    default:
      return null;
  }
}

export const ROOM_ID_RE = /^[a-z2-9]{12}$/;
