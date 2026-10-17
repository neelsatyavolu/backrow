// Runs in Peacock's own page context (manifest world: MAIN). Peacock stitches
// ads into the video stream, so the <video> clock includes each viewer's own
// ad breaks and two viewers can be minutes apart on the same scene. The app's
// playback context lists every ad break (position in content time, length);
// this publishes that list and the real content duration for the content
// script, which converts between stream time and shared content time.

export {};

interface AdBreak {
  position?: unknown;
  expectedDuration?: unknown;
}

interface PlaybackContext {
  allAdBreakData?: AdBreak[];
  assetData?: { attributes?: { durationSeconds?: unknown } };
}

type Fiber = { return: Fiber | null; memoizedProps?: { value?: unknown } };

function findContext(): PlaybackContext | null {
  const start = document.querySelector('[data-testid="overlay"]') ?? document.querySelector("video");
  if (!start) return null;
  const key = Object.keys(start).find((k) => k.startsWith("__reactFiber"));
  let fiber = key ? ((start as unknown as Record<string, Fiber>)[key] ?? null) : null;
  for (let i = 0; fiber && i < 80; i++, fiber = fiber.return) {
    const value = fiber.memoizedProps?.value as PlaybackContext | undefined;
    if (value && typeof value === "object" && Array.isArray(value.allAdBreakData)) return value;
  }
  return null;
}

let last = "";

function publish(): void {
  const ctx = findContext();
  if (!ctx) return;
  const breaks = (ctx.allAdBreakData ?? [])
    .map((b) => [Number(b.position), Number(b.expectedDuration)])
    .filter(([p, d]) => Number.isFinite(p) && Number.isFinite(d) && p! >= 0 && d! > 0)
    .sort((a, b) => a[0]! - b[0]!);
  const duration = Number(ctx.assetData?.attributes?.durationSeconds) || 0;
  const json = JSON.stringify({ breaks, duration });
  if (json === last) return;
  last = json;
  document.documentElement.dataset.backrowPeacock = json;
}

setInterval(publish, 2000);
