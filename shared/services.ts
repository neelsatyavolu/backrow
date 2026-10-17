export const STREAMING_SERVICES = ["netflix", "hulu", "peacock", "youtube"] as const;
export type StreamingService = (typeof STREAMING_SERVICES)[number];

export interface StreamingVideo {
  service: StreamingService;
  id: string;
  url: string;
  title?: string;
}

export interface UploadedVideo {
  service: "upload";
  /** R2 object id, also known to the server. */
  id: string;
  /** base64url AES key for the media chunks. Only ever travels encrypted. */
  mediaKey: string;
  name: string;
  size: number;
  mime: string;
}

export type VideoRef = StreamingVideo | UploadedVideo;

export const SERVICE_LABELS: Record<VideoRef["service"], string> = {
  netflix: "Netflix",
  hulu: "Hulu",
  peacock: "Peacock",
  youtube: "YouTube",
  upload: "Uploaded video",
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
  const v = path === "/watch" ? url.searchParams.get("v") : null;
  if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) {
    return { service, id: v, url: `https://www.youtube.com/watch?v=${v}` };
  }
  return null;
}

export function sameVideo(a: VideoRef | null | undefined, b: VideoRef | null | undefined): boolean {
  return !!a && !!b && a.service === b.service && a.id === b.id;
}
