// Player adapters for each streaming site. Most sites expose a normal <video>
// element; Netflix needs its own player API for seeking, reached through a
// small script in the page's main world (netflix-main.ts).

import type { StreamingService } from "../../shared/services";
import type { PlayerAdapter, PlayerEvent, PlayerSnapshot } from "../../shared/sync-controller";

const EVENTS: PlayerEvent[] = ["play", "pause", "seeking", "seeked", "ratechange"];

/** The main video on the page: the largest one that has loaded media. */
export function findVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of Array.from(document.querySelectorAll("video"))) {
    if (v.readyState === 0 || !Number.isFinite(v.duration) || v.duration <= 0) continue;
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

function netflixCommand(cmd: "seek" | "play" | "pause", ms = 0): void {
  document.dispatchEvent(new CustomEvent("backrow:netflix", { detail: JSON.stringify({ cmd, ms }) }));
}

export function createAdapter(service: StreamingService): PlayerAdapter {
  const netflix = service === "netflix";
  return {
    // Netflix rejects playbackRate changes and fights direct currentTime writes.
    canNudge: !netflix,
    snapshot(): PlayerSnapshot | null {
      const v = findVideo();
      if (!v) return null;
      return { playing: !v.paused, position: v.currentTime, rate: v.playbackRate, duration: v.duration };
    },
    play() {
      if (netflix) return netflixCommand("play");
      findVideo()
        ?.play()
        .catch(() => undefined);
    },
    pause() {
      if (netflix) return netflixCommand("pause");
      findVideo()?.pause();
    },
    seek(seconds) {
      if (netflix) return netflixCommand("seek", Math.round(seconds * 1000));
      const v = findVideo();
      if (v) v.currentTime = seconds;
    },
    setRate(rate) {
      const v = findVideo();
      if (v && !netflix) v.playbackRate = rate;
    },
    inAd() {
      if (service === "youtube") return document.querySelector(".html5-video-player.ad-showing") !== null;
      return false;
    },
    onEvent(cb) {
      // Media events do not bubble, but a capturing listener on the document
      // sees them for whichever <video> the site swaps in.
      const listener = (e: Event) => {
        if (e.target instanceof HTMLVideoElement && e.target === findVideo()) cb(e.type as PlayerEvent);
      };
      for (const type of EVENTS) document.addEventListener(type, listener, true);
      return () => {
        for (const type of EVENTS) document.removeEventListener(type, listener, true);
      };
    },
  };
}
