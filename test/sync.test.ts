import { describe, expect, it } from "vitest";
import { ClockSync, correction, expectedPosition, formatTime, matchesRoom } from "../shared/sync";

const state = { playing: true, position: 100, rate: 1, duration: 3600, at: 10_000 };

describe("sync math", () => {
  it("extrapolates position while playing", () => {
    expect(expectedPosition(state, 12_000)).toBeCloseTo(102);
    expect(expectedPosition({ ...state, rate: 2 }, 12_000)).toBeCloseTo(104);
    expect(expectedPosition({ ...state, playing: false }, 99_000)).toBe(100);
    expect(expectedPosition({ ...state, duration: 101 }, 20_000)).toBe(101);
  });

  it("picks the gentlest correction", () => {
    expect(correction(100.1, 100, 1, true).kind).toBe("none");
    const ahead = correction(101, 100, 1, true);
    expect(ahead.kind === "nudge" && ahead.rate < 1).toBe(true);
    const behind = correction(99, 100, 1, true);
    expect(behind.kind === "nudge" && behind.rate > 1).toBe(true);
    expect(correction(90, 100, 1, true)).toEqual({ kind: "seek", position: 100 });
    // Seek-only players (Netflix) tolerate more drift before seeking.
    expect(correction(101, 100, 1, false)).toEqual({ kind: "none" });
    expect(correction(101.5, 100, 1, false)).toEqual({ kind: "seek", position: 100 });
  });

  it("detects echoes of the room state", () => {
    expect(matchesRoom({ playing: true, position: 102.3 }, state, 12_000)).toBe(true);
    expect(matchesRoom({ playing: false, position: 102 }, state, 12_000)).toBe(false);
    expect(matchesRoom({ playing: true, position: 110 }, state, 12_000)).toBe(false);
  });

  it("estimates clock offset from the fastest sample", () => {
    const c = new ClockSync();
    c.add(1000, 6050, 1100);
    c.add(2000, 7010, 2020);
    expect(c.offset).toBe(5000);
    expect(c.rtt).toBe(20);
  });

  it("formats times", () => {
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(3725)).toBe("1:02:05");
  });
});
