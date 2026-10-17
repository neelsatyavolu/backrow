import { describe, expect, it } from "vitest";
import { contentToStream, streamToContent } from "../shared/ad-timeline";

// Pre-roll of 20s, a 60s break at content 300 and a 90s break at content 1000.
const breaks = [[0, 20], [300, 60], [1000, 90]] as const;

describe("ad timeline", () => {
  it("maps stream time to content time", () => {
    expect(streamToContent(10, breaks)).toEqual({ content: 0, inAd: true });
    expect(streamToContent(20, breaks)).toEqual({ content: 0, inAd: false });
    expect(streamToContent(320, breaks)).toEqual({ content: 300, inAd: true });
    expect(streamToContent(380, breaks)).toEqual({ content: 300, inAd: false });
    expect(streamToContent(1500, breaks)).toEqual({ content: 1500 - 170, inAd: false });
  });

  it("maps content time back to the stream and round-trips", () => {
    expect(contentToStream(0, breaks)).toBe(20);
    expect(contentToStream(299, breaks)).toBe(319);
    expect(contentToStream(300, breaks)).toBe(380);
    for (const c of [5, 299.5, 300, 640, 999, 1000, 2000]) {
      expect(streamToContent(contentToStream(c, breaks), breaks)).toEqual({ content: c, inAd: false });
    }
  });

  it("is the identity without ads", () => {
    expect(streamToContent(123, [])).toEqual({ content: 123, inAd: false });
    expect(contentToStream(123, [])).toBe(123);
  });

  it("keeps two viewers with different ads on the same scene", () => {
    const other = [[0, 15], [300, 90], [1000, 30]] as const;
    const scene = 1200;
    expect(streamToContent(contentToStream(scene, breaks), breaks).content).toBe(scene);
    expect(streamToContent(contentToStream(scene, other), other).content).toBe(scene);
    expect(contentToStream(scene, breaks)).not.toBe(contentToStream(scene, other));
  });
});
