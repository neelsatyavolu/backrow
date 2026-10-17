// Keeps one local video player in step with the room. Shared by the browser
// extension (Netflix, Hulu, Peacock, YouTube) and the web player for uploads.

import type { PlaybackState } from "./payload";
import { correction, expectedPosition, matchesRoom, SYNC } from "./sync";

export interface PlayerSnapshot {
  playing: boolean;
  position: number;
  rate: number;
  duration: number;
  /** Waiting for data (seeking or stalled): position isn't advancing on its own. */
  buffering?: boolean;
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
  /** Optional trace hook for debugging sync decisions. */
  debug?(msg: string, data?: unknown): void;
  serverNow(): number;
  roomState(): PlaybackState | null;
  canControl(): boolean;
  sendState(state: Omit<PlaybackState, "at">): void;
}

const APPLY_QUIET_MS = 900;
/** A position change this far from what playback predicts is a seek, events or not. */
const JUMP_SECONDS = 2;
const TICK_MS = 1000;
/** Durations further apart than this mean we are not on the same video (e.g. an ad). */
const DURATION_MISMATCH = 5;

interface Expectation {
  until: number;
  playing: boolean;
  position: number;
}

export class SyncController {
  /** What our own last command should produce, so its echo events are ignored. */
  private expected: Expectation | null = null;
  private recheck: ReturnType<typeof setTimeout> | null = null;
  private nudging = false;
  private lastDriftSeek = 0;
  private lastTick: { position: number; playing: boolean; rate: number; at: number } | null = null;
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
    if (this.recheck) clearTimeout(this.recheck);
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
    if (this.offVideo(snap, state)) {
      this.link.debug?.("apply skipped: different video or ad", { snap, state });
      return;
    }
    this.link.debug?.("apply remote", { snap, state, expected: expectedPosition(state, this.link.serverNow()) });
    this.lastTick = null;
    const target = expectedPosition(state, this.link.serverNow());
    this.expect(state.playing, target);
    this.nudging = false;
    if (Math.abs(snap.rate - state.rate) > 0.01) this.player.setRate(state.rate);
    const off = Math.abs(snap.position - target);
    if (state.playing) {
      if (off > 0.4) this.player.seek(target);
      if (!snap.playing) this.player.play();
    } else {
      if (snap.playing) this.player.pause();
      if (off > 0.2) this.player.seek(target);
    }
  }

  private expect(playing: boolean, position: number): void {
    this.expected = { until: Date.now() + APPLY_QUIET_MS, playing, position };
  }

  private get quiet(): boolean {
    return !!this.expected && Date.now() < this.expected.until;
  }

  /**
   * During the window after our own command, events that match it are echoes.
   * Anything else might be the user, or a site quirk (Netflix pauses briefly
   * inside every seek), so it is looked at again once the window closes.
   */
  private isEcho(e: PlayerEvent, snap: PlayerSnapshot): boolean {
    const x = this.expected;
    if (!x || Date.now() >= x.until) return false;
    const matches =
      e === "ratechange" ||
      ((e === "play" || e === "pause") && snap.playing === x.playing) ||
      ((e === "seeking" || e === "seeked") && Math.abs(snap.position - x.position) < 1.5);
    if (!matches && !this.recheck) {
      this.recheck = setTimeout(() => {
        this.recheck = null;
        this.onLocal(e);
      }, x.until - Date.now() + 50);
    }
    return true;
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
    const snap = this.player.snapshot();
    this.link.debug?.(`local ${e}`, { quiet: this.quiet, snap });
    if (!snap || this.player.inAd() || this.isEcho(e, snap)) return;
    if (e === "ratechange" && this.nudging) return;
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
    this.link.debug?.("publish", snap);
    this.publish(snap);
  }

  private restoreRate(): void {
    if (!this.nudging) return;
    this.nudging = false;
    const room = this.link.roomState();
    const snap = this.player.snapshot();
    if (snap) this.expect(snap.playing, snap.position);
    this.player.setRate(room?.rate ?? 1);
  }

  /**
   * Some players (Hulu, while paused) seek without firing media events, so a
   * position that moved further than playback explains counts as a local seek.
   */
  private jumped(snap: PlayerSnapshot | null): boolean {
    const prev = this.lastTick;
    const now = Date.now();
    this.lastTick = snap ? { position: snap.position, playing: snap.playing, rate: snap.rate, at: now } : null;
    if (!prev || !snap || this.quiet) return false;
    const predicted = prev.position + (prev.playing ? ((now - prev.at) / 1000) * prev.rate : 0);
    // A buffering stall leaves the position near where it was, so only count
    // moves forward past the prediction or backward from the last position.
    return snap.position > predicted + JUMP_SECONDS || snap.position < prev.position - JUMP_SECONDS;
  }

  private tick(): void {
    const snap = this.player.snapshot();
    if (this.jumped(snap)) {
      this.onLocal("seeked");
      return;
    }
    if (this.quiet || this.recheck) return;
    const room = this.link.roomState();
    if (!room || !snap || this.offVideo(snap, room)) return;
    // A buffering player can't catch up yet; chasing the clock only adds seeks.
    if (snap.buffering) return;

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
      if (Date.now() - this.lastDriftSeek < SYNC.seekCooldownMs) return;
      this.lastDriftSeek = Date.now();
      this.link.debug?.("drift seek", { from: snap.position, to: fix.position });
      this.nudging = false;
      this.lastTick = null;
      this.expect(room.playing, fix.position);
      this.player.setRate(room.rate);
      this.player.seek(fix.position);
    }
  }
}
