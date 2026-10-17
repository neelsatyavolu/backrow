import { describe, expect, it } from "vitest";
import { parseVideoUrl } from "../shared/services";
import { parseChat, parseProfile, parseReaction, parseState, parseVideo } from "../shared/payload";

describe("parseVideoUrl", () => {
  it("recognises each service", () => {
    expect(parseVideoUrl("https://www.netflix.com/watch/80100172?trackId=1")).toEqual({
      service: "netflix", id: "80100172", url: "https://www.netflix.com/watch/80100172",
    });
    expect(parseVideoUrl("https://www.hulu.com/watch/5c6a2a1f-1f2e-4b9a-9a3c-0e3b1d2c3a4b")?.service).toBe("hulu");
    expect(parseVideoUrl("https://www.peacocktv.com/watch/playback/vod/GMO_00000000224510/abc-123")).toEqual({
      service: "peacock", id: "vod/GMO_00000000224510/abc-123", url: "https://www.peacocktv.com/watch/playback/vod/GMO_00000000224510/abc-123",
    });
    expect(parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10")?.id).toBe("dQw4w9WgXcQ");
  });

  it("rejects other pages and hosts", () => {
    expect(parseVideoUrl("https://www.netflix.com/browse")).toBeNull();
    expect(parseVideoUrl("http://www.netflix.com/watch/1")).toBeNull();
    expect(parseVideoUrl("https://evil.com/watch/1")).toBeNull();
    expect(parseVideoUrl("https://www.youtube.com/")).toBeNull();
    expect(parseVideoUrl("nonsense")).toBeNull();
  });
});

describe("payload validation", () => {
  it("profiles", () => {
    expect(parseProfile({ name: "  Neel \n S ", color: 2 })).toEqual({ name: "Neel S", color: 2 });
    expect(parseProfile({ name: "", color: 1 })).toBeNull();
    expect(parseProfile({ name: "x", color: 99 })).toBeNull();
  });

  it("profile photos", () => {
    const photo = "data:image/webp;base64," + "A".repeat(200) + "==";
    expect(parseProfile({ name: "A", color: 0, photo })).toEqual({ name: "A", color: 0, photo });
    // Unknown, oversized or markup-capable values are dropped, not the whole profile.
    expect(parseProfile({ name: "A", color: 0, photo: "data:image/svg+xml;base64,PHN2Zz4=" })).toEqual({ name: "A", color: 0 });
    expect(parseProfile({ name: "A", color: 0, photo: "javascript:alert(1)" })).toEqual({ name: "A", color: 0 });
    expect(parseProfile({ name: "A", color: 0, photo: "data:image/png;base64," + "A".repeat(9000) })).toEqual({ name: "A", color: 0 });
  });

  it("playback state", () => {
    const ok = { playing: true, position: 12, rate: 1, duration: 100, at: 5 };
    expect(parseState(ok)).toEqual(ok);
    expect(parseState({ ...ok, rate: 10 })).toBeNull();
    expect(parseState({ ...ok, position: Number.NaN })).toBeNull();
  });

  it("chat and reactions", () => {
    expect(parseChat({ text: " hi " })).toEqual({ text: "hi" });
    expect(parseChat({ text: "x".repeat(501) })).toBeNull();
    expect(parseReaction({ emoji: "🔥" })).toEqual({ emoji: "🔥" });
    expect(parseReaction({ emoji: "<script>" })).toBeNull();
  });

  it("videos must be canonical", () => {
    const v = { service: "netflix", id: "1", url: "https://www.netflix.com/watch/1" };
    expect(parseVideo(v)).toEqual(v);
    expect(parseVideo({ ...v, id: "2" })).toBeNull();
    expect(parseVideo({ ...v, url: "https://evil.com/watch/1" })).toBeNull();
    const up = { service: "upload", id: "abcdefghijkmnpqr", mediaKey: "a".repeat(43), name: "film.mp4", size: 10, mime: "video/mp4" };
    expect(parseVideo(up)).toEqual(up);
    expect(parseVideo({ ...up, mime: "text/html" })).toBeNull();
  });
});
