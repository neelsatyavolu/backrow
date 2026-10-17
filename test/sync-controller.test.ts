import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackState } from "../shared/payload";
import { SyncController, type PlayerAdapter, type PlayerEvent, type PlayerSnapshot } from "../shared/sync-controller";

function fakePlayer(init: Partial<PlayerSnapshot> = {}) {
  const snap: PlayerSnapshot = { playing: false, position: 0, rate: 1, duration: 600, ...init };
  let cb: ((e: PlayerEvent) => void) | null = null;
  const calls: string[] = [];
  const player: PlayerAdapter = {
    canNudge: true,
    snapshot: () => ({ ...snap }),
    play: () => { calls.push("play"); snap.playing = true; },
    pause: () => { calls.push("pause"); snap.playing = false; },
    seek: (s) => { calls.push(`seek:${s.toFixed(1)}`); snap.position = s; },
    setRate: (r) => { calls.push(`rate:${r.toFixed(2)}`); snap.rate = r; },
    inAd: () => false,
    onEvent: (fn) => { cb = fn; return () => { cb = null; }; },
  };
  return { player, snap, calls, fire: (e: PlayerEvent) => cb?.(e) };
}

describe("SyncController", () => {
  let now = 1_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  function setup(room: PlaybackState | null, canControl = true, init: Partial<PlayerSnapshot> = {}) {
    const p = fakePlayer(init);
    const sent: Array<Omit<PlaybackState, "at">> = [];
    let state = room;
    const ctl = new SyncController(p.player, {
      serverNow: () => Date.now(),
      roomState: () => state,
      canControl: () => canControl,
      sendState: (s) => { sent.push(s); state = { ...s, at: Date.now() }; },
    });
    ctl.start();
    return { ...p, ctl, sent, setRoom: (s: PlaybackState) => (state = s) };
  }

  it("jumps to a playing room on join", () => {
    const t = setup({ playing: true, position: 100, rate: 1, duration: 600, at: Date.now() - 2000 });
    t.ctl.applyRemote({ playing: true, position: 100, rate: 1, duration: 600, at: Date.now() - 2000 });
    expect(t.calls).toEqual(["seek:102.0", "play"]);
  });

  it("does not echo remote changes back", () => {
    const t = setup({ playing: true, position: 50, rate: 1, duration: 600, at: Date.now() });
    t.ctl.applyRemote({ playing: true, position: 50, rate: 1, duration: 600, at: Date.now() });
    t.fire("play");
    t.fire("seeked");
    vi.advanceTimersByTime(1000);
    t.snap.position = 51; // a real player keeps playing
    t.fire("play");
    expect(t.sent).toHaveLength(0);
  });

  it("broadcasts a real local pause", () => {
    const t = setup({ playing: true, position: 10, rate: 1, duration: 600, at: Date.now() }, true, { playing: true, position: 10 });
    vi.advanceTimersByTime(1500);
    t.snap.playing = false;
    t.fire("pause");
    expect(t.sent.at(-1)).toMatchObject({ playing: false });
  });

  it("snaps back when the host controls playback", () => {
    const t = setup({ playing: true, position: 10, rate: 1, duration: 600, at: Date.now() }, false, { playing: true, position: 10 });
    vi.advanceTimersByTime(1500);
    t.snap.playing = false;
    t.fire("pause");
    expect(t.sent).toHaveLength(0);
    expect(t.calls).toContain("play");
  });

  it("nudges small drift and seeks large drift", () => {
    const t = setup({ playing: true, position: 0, rate: 1, duration: 600, at: Date.now() }, true, { playing: true, position: 0 });
    // Player falls 1s behind: expect a speed-up, not a seek.
    vi.advanceTimersByTime(2000);
    t.snap.position = 1.0;
    vi.advanceTimersByTime(1000);
    expect(t.calls.some((c) => c.startsWith("rate:1.0") && c !== "rate:1.00")).toBe(true);
    expect(t.calls.some((c) => c.startsWith("seek"))).toBe(false);
    // Way behind: seek.
    t.snap.position = 0;
    vi.advanceTimersByTime(1000);
    expect(t.calls.some((c) => c.startsWith("seek"))).toBe(true);
  });

  it("ignores state for a different video length (an ad)", () => {
    const t = setup(null, true, { playing: true, position: 3, duration: 30 });
    t.ctl.applyRemote({ playing: true, position: 300, rate: 1, duration: 3000, at: Date.now() });
    expect(t.calls).toHaveLength(0);
  });

  it("seeds an empty room", () => {
    const t = setup(null, true, { playing: true, position: 12 });
    t.ctl.applyRemote(null);
    expect(t.sent[0]).toMatchObject({ playing: true, position: 12 });
  });
});

describe("SyncController seeking", () => {
  it("treats a seek in progress as a user action, not drift", () => {
    vi.useFakeTimers();
    const p = fakePlayer({ playing: true, position: 10 });
    const sent: unknown[] = [];
    let state: PlaybackState | null = { playing: true, position: 10, rate: 1, duration: 600, at: Date.now() };
    const ctl = new SyncController(p.player, {
      serverNow: () => Date.now(),
      roomState: () => state,
      canControl: () => true,
      sendState: (s) => { sent.push(s); state = { ...s, at: Date.now() }; },
    });
    ctl.start();
    vi.advanceTimersByTime(1500);
    p.snap.position = 120;
    p.fire("seeking");
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
    expect(p.calls.some((c) => c.startsWith("seek"))).toBe(false);
    ctl.stop();
    vi.useRealTimers();
  });
});
