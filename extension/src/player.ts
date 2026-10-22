// Player adapters for each streaming site. YouTube, Peacock, Prime Video and
// HBO Max expose a normal <video> element. Netflix, Hulu and Disney+ must be
// driven through their own player APIs, reached through small scripts in the
// page's main world (netflix-main.ts, hulu-main.ts, disney-main.ts):
// - Netflix throws a playback error when currentTime is written directly.
// - Hulu only buffers ahead a little, so a direct seek past the buffer is
//   clamped, and its element clock runs a few seconds off the content clock.
// - Disney+'s element clock is relative to its stream buffer, not the show.
// Peacock stitches ads into the stream; peacock-main.ts publishes the ad
// breaks so positions here are always ad-free content time.

import { contentToStream, streamToContent, type AdBreaks } from "../../shared/ad-timeline";
import type { StreamingService } from "../../shared/services";
import type { PlayerAdapter, PlayerEvent, PlayerSnapshot } from "../../shared/sync-controller";

const EVENTS: PlayerEvent[] = ["play", "pause", "seeking", "seeked", "ratechange"];

/** The main video on the page: the largest loaded one, preferring one that is playing. */
export function findVideo(root: ParentNode = document): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestScore = 0;
  for (const v of Array.from(root.querySelectorAll("video"))) {
    if (v.readyState === 0 || Number.isNaN(v.duration) || v.duration <= 0) continue;
    const r = v.getBoundingClientRect();
    const score = r.width * r.height * (v.paused ? 1 : 2);
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

type Command = "seek" | "play" | "pause";
type Bridge = "netflix" | "hulu" | "disney";

/** Sends a command to the main-world bridge for sites that need their own API. */
function pageCommand(service: Bridge, cmd: Command, seconds = 0): void {
  document.dispatchEvent(new CustomEvent(`backrow:${service}`, { detail: JSON.stringify({ cmd, seconds }) }));
}

/** Peacock's ad breaks and real duration, published by peacock-main.ts. */
function peacockTimeline(): { breaks: AdBreaks; duration: number } {
  try {
    const raw = JSON.parse(document.documentElement.dataset.backrowPeacock ?? "null") as { breaks?: unknown; duration?: unknown } | null;
    const breaks = Array.isArray(raw?.breaks)
      ? (raw.breaks as unknown[]).filter(
          (b): b is [number, number] => Array.isArray(b) && b.length === 2 && b.every((n) => typeof n === "number" && Number.isFinite(n)),
        )
      : [];
    return { breaks, duration: typeof raw?.duration === "number" ? raw.duration : 0 };
  } catch {
    return { breaks: [], duration: 0 };
  }
}

interface Site {
  video(): HTMLVideoElement | null;
  /** Seek target on the element's own clock for a content position. */
  toElement?(content: number): number;
  /** Content position, which can differ from the element clock (Hulu, Disney+). */
  position(v: HTMLVideoElement): number;
  duration(v: HTMLVideoElement): number;
  bridge: Bridge | null;
  canNudge: boolean;
  inAd(): boolean;
}

function site(service: StreamingService): Site {
  const plain = {
    video: findVideo,
    position: (v: HTMLVideoElement) => v.currentTime,
    duration: (v: HTMLVideoElement) => (Number.isFinite(v.duration) ? v.duration : 0),
  };
  switch (service) {
    case "netflix":
      return { ...plain, bridge: "netflix", canNudge: false, inAd: () => false };
    case "hulu":
      return {
        video: () => document.querySelector<HTMLVideoElement>("video.ContentPlayer__videoPlayer") ?? findVideo(),
        position: (v) => v.currentTime - (Number(document.documentElement.dataset.backrowHuluOffset) || 0),
        // The element reports an infinite duration; the timeline slider has the real one.
        duration: () => Number(document.querySelector(".Timeline__slider")?.getAttribute("aria-valuemax")) || 0,
        bridge: "hulu",
        canNudge: true,
        inAd: () => {
          const ad = document.querySelector<HTMLVideoElement>("video.AdPlayer__video");
          return !!ad && !ad.paused && ad.getBoundingClientRect().width > 0;
        },
      };
    case "youtube":
      return { ...plain, bridge: null, canNudge: true, inAd: () => document.querySelector(".html5-video-player.ad-showing") !== null };
    case "peacock":
      return {
        video: findVideo,
        position: (v) => streamToContent(v.currentTime, peacockTimeline().breaks).content,
        duration: (v) => peacockTimeline().duration || plain.duration(v),
        toElement: (content) => contentToStream(content, peacockTimeline().breaks),
        bridge: null,
        canNudge: true,
        inAd: () => {
          const v = findVideo();
          return !!v && streamToContent(v.currentTime, peacockTimeline().breaks).inAd;
        },
      };
    case "prime": {
      // Only the player overlay, not the trailer that autoplays behind it.
      const video = () => {
        const root = document.querySelector("#dv-web-player, .webPlayerSDKContainer");
        return root ? findVideo(root) : null;
      };
      return { ...plain, video, bridge: null, canNudge: true, inAd: () => false };
    }
    case "hbomax":
      return { ...plain, bridge: null, canNudge: true, inAd: () => false };
    case "disney":
      return {
        video: () => {
          const root = document.querySelector("disney-web-player");
          return root ? findVideo(root) : findVideo();
        },
        position: (v) => v.currentTime - (Number(document.documentElement.dataset.backrowDisneyOffset) || 0),
        duration: (v) => Number(document.documentElement.dataset.backrowDisneyDuration) || plain.duration(v),
        bridge: "disney",
        canNudge: true,
        inAd: () => false,
      };
  }
}

export function createAdapter(service: StreamingService): PlayerAdapter {
  const s = site(service);
  return {
    canNudge: s.canNudge,
    snapshot(): PlayerSnapshot | null {
      const v = s.video();
      if (!v) return null;
      return {
        playing: !v.paused,
        position: Math.max(0, s.position(v)),
        rate: v.playbackRate,
        duration: s.duration(v),
        buffering: v.seeking || v.readyState < 3,
      };
    },
    play() {
      if (s.bridge) return pageCommand(s.bridge, "play");
      s.video()
        ?.play()
        .catch(() => undefined);
    },
    pause() {
      if (s.bridge) return pageCommand(s.bridge, "pause");
      s.video()?.pause();
    },
    seek(seconds) {
      if (s.bridge) return pageCommand(s.bridge, "seek", seconds);
      const v = s.video();
      if (v) v.currentTime = s.toElement ? s.toElement(seconds) : seconds;
    },
    setRate(rate) {
      const v = s.video();
      if (v && s.canNudge) v.playbackRate = rate;
    },
    inAd: s.inAd,
    onEvent(cb) {
      // Media events do not bubble, but a capturing listener on the document
      // sees them for whichever <video> the site swaps in.
      const listener = (e: Event) => {
        if (e.target instanceof HTMLVideoElement && e.target === s.video()) cb(e.type as PlayerEvent);
      };
      for (const type of EVENTS) document.addEventListener(type, listener, true);
      return () => {
        for (const type of EVENTS) document.removeEventListener(type, listener, true);
      };
    },
  };
}
