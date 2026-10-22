export const STREAMING_SERVICES = ["netflix", "hulu", "peacock", "youtube", "prime", "hbomax", "disney"] as const;
export type StreamingService = (typeof STREAMING_SERVICES)[number];

export interface StreamingVideo {
  service: StreamingService;
  id: string;
  url: string;
  title?: string;
}

/** A file streamed live from the host's computer; nothing is uploaded. */
export interface LocalVideo {
  service: "local";
  name: string;
}

export type VideoRef = StreamingVideo | LocalVideo;

export const SERVICE_LABELS: Record<VideoRef["service"], string> = {
  netflix: "Netflix",
  hulu: "Hulu",
  peacock: "Peacock",
  youtube: "YouTube",
  prime: "Prime Video",
  hbomax: "HBO Max",
  disney: "Disney+",
  local: "Streamed from the host",
};

const HOSTS: Record<string, StreamingService> = {
  "www.netflix.com": "netflix",
  "netflix.com": "netflix",
  "www.hulu.com": "hulu",
  "hulu.com": "hulu",
  "www.peacocktv.com": "peacock",
  "peacocktv.com": "peacock",
  "www.youtube.com": "youtube",
  "youtube.com": "youtube",
  "m.youtube.com": "youtube",
  "www.primevideo.com": "prime",
  "primevideo.com": "prime",
  "play.hbomax.com": "hbomax",
  "www.disneyplus.com": "disney",
  "disneyplus.com": "disney",
};

export function serviceForHost(host: string): StreamingService | null {
  return HOSTS[host.toLowerCase()] ?? null;
}

/** Turns a watch-page URL into a canonical reference, or null if it is not one. */
export function parseVideoUrl(input: string): StreamingVideo | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const service = serviceForHost(url.hostname);
  if (!service) return null;
  const path = url.pathname;

  if (service === "netflix") {
    const m = path.match(/^\/watch\/(\d+)/);
    return m ? { service, id: m[1]!, url: `https://www.netflix.com/watch/${m[1]}` } : null;
  }
  if (service === "hulu") {
    const m = path.match(/^\/watch\/([0-9a-f-]{8,64})/i);
    return m ? { service, id: m[1]!, url: `https://www.hulu.com/watch/${m[1]}` } : null;
  }
  if (service === "peacock") {
    const m = path.match(/^\/watch\/playback\/([A-Za-z0-9_\-/.]{3,200})$/);
    if (!m) return null;
    const id = m[1]!.replace(/\/+$/, "");
    return { service, id, url: `https://www.peacocktv.com/watch/playback/${id}` };
  }
  if (service === "prime") {
    // /detail/<id>, /detail/<slug>/<id>, /region/eu/detail/<id>/ref=..., /dp/<id>
    const m = path.match(/\/(?:detail|dp)\/(?:[^/]+\/)?([0-9A-Z]{10,40})(?:\/|$)/);
    return m ? { service, id: m[1]!, url: `https://www.primevideo.com/detail/${m[1]}` } : null;
  }
  if (service === "hbomax") {
    const m = path.match(/^\/video\/watch\/([0-9a-f-]{36})\/([0-9a-f-]{36})/i);
    if (!m) return null;
    const id = `${m[1]}/${m[2]}`.toLowerCase();
    return { service, id, url: `https://play.hbomax.com/video/watch/${id}` };
  }
  if (service === "disney") {
    // An optional locale prefix: /play/<id> or /en-gb/play/<id>
    const m = path.match(/^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/play\/([0-9a-f-]{36})(?:\/|$)/i);
    if (!m) return null;
    const id = m[1]!.toLowerCase();
    return { service, id, url: `https://www.disneyplus.com/play/${id}` };
  }
  const v = path === "/watch" ? url.searchParams.get("v") : null;
  if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) {
    return { service, id: v, url: `https://www.youtube.com/watch?v=${v}` };
  }
  return null;
}

/** Stable identity of a video: the site's id, or the file name for a local stream. */
export function videoKey(v: VideoRef): string {
  return v.service === "local" ? `local:${v.name}` : `${v.service}:${v.id}`;
}

export function sameVideo(a: VideoRef | null | undefined, b: VideoRef | null | undefined): boolean {
  return !!a && !!b && videoKey(a) === videoKey(b);
}
