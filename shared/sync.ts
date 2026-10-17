// Clock and drift math shared by the extension and the web player.

import type { PlaybackState } from "./payload";

/** Estimates the offset between this clock and the server's from ping/pong samples. */
export class ClockSync {
  private samples: ReadonlyArray<{ rtt: number; offset: number }> = [];

  add(clientSent: number, serverTime: number, clientReceived: number): void {
    const rtt = Math.max(0, clientReceived - clientSent);
    const offset = serverTime - (clientSent + rtt / 2);
    this.samples = [...this.samples, { rtt, offset }].slice(-8);
  }

  /** Offset from the lowest-latency recent sample, which has the least error. */
  get offset(): number {
    if (this.samples.length === 0) return 0;
    return this.samples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;
  }

  get rtt(): number {
    return this.samples.length ? Math.min(...this.samples.map((s) => s.rtt)) : 0;
  }

  serverNow(localNow = Date.now()): number {
    return localNow + this.offset;
  }
}

export function expectedPosition(state: PlaybackState, serverNow: number): number {
  if (!state.playing) return state.position;
  const elapsed = Math.max(0, serverNow - state.at) / 1000;
  const pos = state.position + elapsed * state.rate;
  return state.duration > 0 ? Math.min(pos, state.duration) : pos;
}

export const SYNC = {
  /** Within this, a local event matches the room and is not re-broadcast. */
  echoTolerance: 0.9,
  /** Drift below this is ignored. */
  deadband: 0.25,
  /**
   * Same, for players that can only seek (Netflix): every seek there rebuffers
   * briefly, so chasing small drift causes a constant stutter.
   */
  seekOnlyDeadband: 1.2,
  /** Minimum gap between drift-correcting seeks, so a slow player never loops. */
  seekCooldownMs: 5000,
  /** Drift above this is fixed by seeking instead of a speed nudge. */
  seekThreshold: 2.5,
  /** Max speed change while nudging, as a fraction of the room rate. */
  nudge: 0.08,
} as const;

export type Correction =
  | { kind: "none" }
  | { kind: "nudge"; rate: number }
  | { kind: "seek"; position: number };

/**
 * How a playing follower should catch up: ignore tiny drift, speed up or slow
 * down slightly for small drift (no visible jump), seek for large drift.
 */
export function correction(localPosition: number, expected: number, roomRate: number, canNudge: boolean): Correction {
  const drift = localPosition - expected;
  const abs = Math.abs(drift);
  if (abs < (canNudge ? SYNC.deadband : SYNC.seekOnlyDeadband)) return { kind: "none" };
  if (!canNudge || abs >= SYNC.seekThreshold) return { kind: "seek", position: expected };
  const strength = Math.min(1, abs / 1.5);
  const delta = SYNC.nudge * Math.max(0.35, strength);
  return { kind: "nudge", rate: roomRate * (drift > 0 ? 1 - delta : 1 + delta) };
}

/** True when a local player snapshot already agrees with the room. */
export function matchesRoom(
  local: { playing: boolean; position: number },
  state: PlaybackState,
  serverNow: number,
): boolean {
  return local.playing === state.playing && Math.abs(local.position - expectedPosition(state, serverNow)) < SYNC.echoTolerance;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
