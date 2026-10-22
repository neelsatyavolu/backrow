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

  it("recognises Prime Video detail pages in their different shapes", () => {
    const boys = { service: "prime", id: "0KRGHGZCHKS920ZQGY5LBRF7MA", url: "https://www.primevideo.com/detail/0KRGHGZCHKS920ZQGY5LBRF7MA" };
    expect(parseVideoUrl("https://www.primevideo.com/detail/0KRGHGZCHKS920ZQGY5LBRF7MA/ref=atv_hm_hom_c_1?autoplay=1")).toEqual(boys);
    expect(parseVideoUrl("https://www.primevideo.com/detail/The-Boys/0KRGHGZCHKS920ZQGY5LBRF7MA")).toEqual(boys);
    expect(parseVideoUrl("https://www.primevideo.com/region/eu/detail/0KRGHGZCHKS920ZQGY5LBRF7MA/")).toEqual(boys);
    expect(parseVideoUrl("https://www.primevideo.com/-/es/detail/0KRGHGZCHKS920ZQGY5LBRF7MA")).toEqual(boys);
    expect(parseVideoUrl("https://www.primevideo.com/dp/B07FMHTRFR")?.id).toBe("B07FMHTRFR");
    expect(parseVideoUrl("https://www.primevideo.com/storefront/home")).toBeNull();
  });

  it("recognises HBO Max and Disney+ watch pages", () => {
    const edit = "2b4a0f6c-3b0e-4b8e-9b1a-5c6d7e8f9a0b";
    const show = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    expect(parseVideoUrl(`https://play.hbomax.com/video/watch/${show}/${edit.toUpperCase()}?foo=1`)).toEqual({
      service: "hbomax", id: `${show}/${edit}`, url: `https://play.hbomax.com/video/watch/${show}/${edit}`,
    });
    expect(parseVideoUrl(`https://play.hbomax.com/show/${show}`)).toBeNull();
    const play = { service: "disney", id: edit, url: `https://www.disneyplus.com/play/${edit}` };
    expect(parseVideoUrl(`https://www.disneyplus.com/play/${edit}`)).toEqual(play);
    expect(parseVideoUrl(`https://www.disneyplus.com/en-gb/play/${edit}`)).toEqual(play);
    expect(parseVideoUrl("https://www.disneyplus.com/browse/entity-123")).toBeNull();
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
    expect(parseVideo({ service: "local", name: "film.mp4" })).toEqual({ service: "local", name: "film.mp4" });
    expect(parseVideo({ service: "local", name: "" })).toBeNull();
  });
});
