// Runs in Disney+'s own page context (manifest world: MAIN). The <video>
// clock is relative to the stream buffer rather than the show, so its
// currentTime is neither the show position nor a safe seek target. The media
// player on <disney-web-player> knows the real playhead and seeks by it; the
// offset and duration are published for the content script (which can't call
// page functions) to read.

interface DisneyMediaPlayer {
  seek(ms: number): unknown;
  timeline?: { info?: { playheadPositionMs?: unknown; programDurationMs?: unknown } };
}

function player(): DisneyMediaPlayer | null {
  try {
    const el = document.querySelector("disney-web-player") as (Element & { mediaPlayer?: DisneyMediaPlayer }) | null;
    return el?.mediaPlayer ?? null;
  } catch {
    return null;
  }
}

function contentVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>("disney-web-player video");
}

function offset(): number {
  return Number(document.documentElement.dataset.backrowDisneyOffset) || 0;
}

function publish(): void {
  const info = player()?.timeline?.info;
  const v = contentVideo();
  if (!info || !v || v.readyState === 0) return;
  const { playheadPositionMs: position, programDurationMs: duration } = info;
  if (typeof position !== "number" || typeof duration !== "number" || duration <= 0) return;
  const next = v.currentTime - position / 1000;
  if (!Number.isFinite(next)) return;
  document.documentElement.dataset.backrowDisneyOffset = next.toFixed(3);
  document.documentElement.dataset.backrowDisneyDuration = (duration / 1000).toFixed(3);
}

setInterval(publish, 500);

document.addEventListener("backrow:disney", (e) => {
  const detail = (e as CustomEvent<unknown>).detail;
  if (typeof detail !== "string") return;
  let cmd: { cmd?: unknown; seconds?: unknown };
  try {
    cmd = JSON.parse(detail) as { cmd?: unknown; seconds?: unknown };
  } catch {
    return;
  }
  const p = player();
  const v = contentVideo();
  const s = cmd.seconds;
  if (cmd.cmd === "seek" && typeof s === "number" && Number.isFinite(s) && s >= 0) {
    if (p) void Promise.resolve(p.seek(Math.round(s * 1000))).catch(() => undefined);
    else if (v) v.currentTime = s + offset();
  } else if (cmd.cmd === "play") {
    void v?.play().catch(() => undefined);
  } else if (cmd.cmd === "pause") {
    v?.pause();
  }
  setTimeout(publish, 300);
});

// Module scope: keeps names out of the page and out of the other bridges.
export {};
