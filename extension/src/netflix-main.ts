// Runs in Netflix's own page context (manifest world: MAIN). Setting
// video.currentTime directly makes Netflix throw a playback error, so seeking
// goes through the site's player API instead.

interface NetflixPlayer {
  seek(ms: number): void;
  play(): void;
  pause(): void;
}

interface NetflixGlobal {
  appContext: {
    state: {
      playerApp: {
        getAPI(): {
          videoPlayer: {
            getAllPlayerSessionIds(): string[];
            getVideoPlayerBySessionId(id: string): NetflixPlayer | undefined;
          };
        };
      };
    };
  };
}

function player(): NetflixPlayer | null {
  try {
    const nf = (window as unknown as { netflix?: NetflixGlobal }).netflix;
    const vp = nf?.appContext.state.playerApp.getAPI().videoPlayer;
    const ids = vp?.getAllPlayerSessionIds() ?? [];
    const id = ids.find((s) => s.startsWith("watch")) ?? ids[ids.length - 1];
    return id ? (vp?.getVideoPlayerBySessionId(id) ?? null) : null;
  } catch {
    return null;
  }
}

document.addEventListener("backrow:netflix", (e) => {
  const detail = (e as CustomEvent<unknown>).detail;
  if (typeof detail !== "string") return;
  let cmd: { cmd?: unknown; seconds?: unknown };
  try {
    cmd = JSON.parse(detail) as { cmd?: unknown; seconds?: unknown };
  } catch {
    return;
  }
  const p = player();
  if (!p) return;
  const s = cmd.seconds;
  if (cmd.cmd === "seek" && typeof s === "number" && Number.isFinite(s) && s >= 0) p.seek(Math.round(s * 1000));
  else if (cmd.cmd === "play") p.play();
  else if (cmd.cmd === "pause") p.pause();
});

// Module scope: keeps names out of the page and out of the other bridge.
export {};
