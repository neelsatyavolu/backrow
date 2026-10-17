// Runs in Hulu's own page context (manifest world: MAIN). Hulu buffers only a
// little ahead, so seeking by writing currentTime is clamped to what's loaded;
// its site player API seeks anywhere. The element's clock also runs a few
// seconds off the content clock, so the offset is published for the content
// script (which can't call page functions) to read.

interface HuluSitePlayer {
  seek(seconds: number): void;
  play(): void;
  pause(): void;
  getCurrentTime(): number;
}

function player(): HuluSitePlayer | null {
  try {
    const dash = (window as unknown as { DashPlayer?: { getSitePlayer?(): HuluSitePlayer | null } }).DashPlayer;
    return dash?.getSitePlayer?.() ?? null;
  } catch {
    return null;
  }
}

function contentVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>("video.ContentPlayer__videoPlayer");
}

function publishOffset(): void {
  const p = player();
  const v = contentVideo();
  if (!p || !v || v.readyState === 0) return;
  const offset = v.currentTime - p.getCurrentTime();
  if (Number.isFinite(offset) && Math.abs(offset) < 600) document.documentElement.dataset.backrowHuluOffset = offset.toFixed(3);
}

setInterval(publishOffset, 500);

document.addEventListener("backrow:hulu", (e) => {
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
    if (p) p.seek(s);
    else if (v) v.currentTime = s;
  } else if (cmd.cmd === "play") {
    if (p) p.play();
    else void v?.play().catch(() => undefined);
  } else if (cmd.cmd === "pause") {
    if (p) p.pause();
    else v?.pause();
  }
  setTimeout(publishOffset, 300);
});

// Module scope: keeps names out of the page and out of the other bridge.
export {};
