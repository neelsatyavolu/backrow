// Keeps one local video player in step with the room. Shared by the browser
// extension (Netflix, Hulu, Peacock, YouTube) and the web player for uploads.

import type { PlaybackState } from "./payload";
import { correction, expectedPosition, matchesRoom } from "./sync";

export interface PlayerSnapshot {
  playing: boolean;
  position: number;
  rate: number;
  duration: number;
}

// "seeking" fires the moment someone drags the timeline, before slow sites finish
// buffering, so a user seek is never mistaken for drift.
export type PlayerEvent = "play" | "pause" | "seeking" | "seeked" | "ratechange";

export interface PlayerAdapter {
  /** Whether small drift can be fixed by briefly changing playback speed. */
  readonly canNudge: boolean;
  snapshot(): PlayerSnapshot | null;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
  /** True while an ad (or anything that is not the shared video) is playing. */
  inAd(): boolean;
  onEvent(cb: (e: PlayerEvent) => void): () => void;
}

export interface SyncLink {
  serverNow(): number;
  roomState(): PlaybackState | null;
  canControl(): boolean;
  sendState(state: Omit<PlaybackState, "at">): void;
}

const APPLY_QUIET_MS = 900;
const TICK_MS = 1000;
/** Durations further apart than this mean we are not on the same video (e.g. an ad). */
const DURATION_MISMATCH = 5;

export class SyncController {
  private quietUntil = 0;
  private nudging = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly player: PlayerAdapter,
    private readonly link: SyncLink,
  ) {}

  start(): void {
    this.unsubscribe = this.player.onEvent((e) => this.onLocal(e));
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.restoreRate();
  }

  /** Room state is known (on join or after a remote change): match it now. */
  applyRemote(state: PlaybackState | null): void {
    const snap = this.player.snapshot();
    if (!snap) return;
    if (!state) {
      // Empty room: whoever arrives with a player seeds it.
      if (this.link.canControl()) this.publish(snap);
      return;
    }
    if (this.offVideo(snap, state)) return;
    this.quiet();
    this.nudging = false;
    if (Math.abs(snap.rate - state.rate) > 0.01) this.player.setRate(state.rate);
    const target = expectedPosition(state, this.link.serverNow());
    const off = Math.abs(snap.position - target);
    if (state.playing) {
      if (off > 0.4) this.player.seek(target);
      if (!snap.playing) this.player.play();
    } else {
      if (snap.playing) this.player.pause();
      if (off > 0.2) this.player.seek(target);
    }
  }

  private quiet(): void {
    this.quietUntil = Date.now() + APPLY_QUIET_MS;
  }

  private offVideo(snap: PlayerSnapshot, state: PlaybackState): boolean {
    if (this.player.inAd()) return true;
    return state.duration > 0 && snap.duration > 0 && Math.abs(state.duration - snap.duration) > DURATION_MISMATCH;
  }

  private publish(snap: PlayerSnapshot): void {
    const room = this.link.roomState();
    const rate = this.nudging && room ? room.rate : snap.rate;
    this.link.sendState({ playing: snap.playing, position: snap.position, rate, duration: snap.duration });
  }

  private onLocal(e: PlayerEvent): void {
    if (Date.now() < this.quietUntil || this.player.inAd()) return;
    if (e === "ratechange" && this.nudging) return;
    const snap = this.player.snapshot();
    if (!snap) return;
    const room = this.link.roomState();
    if (room && this.offVideo(snap, room)) return;
    if (room && e !== "ratechange" && matchesRoom(snap, room, this.link.serverNow())) return;
    if (room && e === "ratechange" && Math.abs(snap.rate - room.rate) < 0.01) return;
    if (!this.link.canControl()) {
      // Not allowed to drive: snap back to the room.
      this.applyRemote(room);
      return;
    }
    this.nudging = false;
    this.publish(snap);
  }

  private restoreRate(): void {
    if (!this.nudging) return;
    this.nudging = false;
    const room = this.link.roomState();
    this.quiet();
    this.player.setRate(room?.rate ?? 1);
  }

  private tick(): void {
    if (Date.now() < this.quietUntil) return;
    const room = this.link.roomState();
    const snap = this.player.snapshot();
    if (!room || !snap || this.offVideo(snap, room)) return;

    if (room.playing !== snap.playing) {
      // Autoplay blocked, buffering stall that paused, or a missed event.
      this.applyRemote(room);
      return;
    }
    if (!room.playing) return;

    const fix = correction(snap.position, expectedPosition(room, this.link.serverNow()), room.rate, this.player.canNudge);
    if (fix.kind === "none") {
      this.restoreRate();
    } else if (fix.kind === "nudge") {
      this.nudging = true;
      this.player.setRate(fix.rate);
    } else {
      this.nudging = false;
      this.quiet();
      this.player.setRate(room.rate);
      this.player.seek(fix.position);
    }
  }
}
