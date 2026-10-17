// Custom player controls shared by the host and viewers: play/pause, a seek
// bar with a hover preview time, volume, fullscreen (video and chat together)
// and keyboard shortcuts. Controls fade away while the video plays.

import { formatTime } from "../../shared/sync";

export interface PlayerSource {
  /** Current playback as everyone sees it. */
  state(): { playing: boolean; position: number; duration: number };
  /** Whether this person may drive playback (host-only mode). */
  canControl(): boolean;
  toggle(): void;
  seek(seconds: number): void;
}

const IDLE_MS = 2600;

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}

const ICONS = {
  play: "M7 4.5v15l13-7.5z",
  pause: "M6 4h4.5v16H6zM13.5 4H18v16h-4.5z",
  volume: "M4 9v6h4l5 4V5L8 9zm11.5 3a3.5 3.5 0 0 0-2-3.2v6.4a3.5 3.5 0 0 0 2-3.2zm-2-7.8v2.1a7 7 0 0 1 0 11.4v2.1a9 9 0 0 0 0-15.6z",
  muted: "M4 9v6h4l5 4V5L8 9zm16.6 3 2.2-2.2-1.4-1.4-2.2 2.2-2.2-2.2-1.4 1.4 2.2 2.2-2.2 2.2 1.4 1.4 2.2-2.2 2.2 2.2 1.4-1.4z",
  full: "M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z",
  exit: "M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z",
  back: "M11 6 5 12l6 6v-4.5h3a5 5 0 0 1 0 10h-1v2h1a7 7 0 0 0 0-14h-3z",
  fwd: "M13 6l6 6-6 6v-4.5h-3a5 5 0 0 0 0 10h1v2h-1a7 7 0 0 1 0-14h3z",
};

function button(label: string, path: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pc-btn";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.append(icon(path));
  return b;
}

function setIcon(b: HTMLButtonElement, path: string, label: string): void {
  b.replaceChildren(icon(path));
  b.setAttribute("aria-label", label);
  b.title = label;
}

export class PlayerUI {
  private root: HTMLElement;
  private playBtn: HTMLButtonElement;
  private bigPlay: HTMLButtonElement;
  private bar: HTMLElement;
  private fill: HTMLElement;
  private knob: HTMLElement;
  private hoverTip: HTMLElement;
  private time: HTMLElement;
  private muteBtn: HTMLButtonElement;
  private volume: HTMLInputElement;
  private fsBtn: HTMLButtonElement;
  private status: HTMLElement;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private dragging: number | null = null;
  private raf = 0;

  constructor(
    private readonly screen: HTMLElement,
    private readonly video: HTMLVideoElement,
    private readonly stage: HTMLElement,
    private readonly source: PlayerSource,
  ) {
    this.root = document.createElement("div");
    this.root.className = "pc";

    this.status = document.createElement("div");
    this.status.className = "pc-status";
    this.status.hidden = true;

    this.bigPlay = button("Play", ICONS.play);
    this.bigPlay.classList.add("pc-big");

    const controls = document.createElement("div");
    controls.className = "pc-bar";

    this.bar = document.createElement("div");
    this.bar.className = "pc-track";
    this.bar.setAttribute("role", "slider");
    this.bar.setAttribute("aria-label", "Seek");
    this.bar.tabIndex = 0;
    const rail = document.createElement("div");
    rail.className = "pc-rail";
    this.fill = document.createElement("div");
    this.fill.className = "pc-fill";
    this.knob = document.createElement("div");
    this.knob.className = "pc-knob";
    this.hoverTip = document.createElement("div");
    this.hoverTip.className = "pc-tip";
    rail.append(this.fill);
    this.bar.append(rail, this.knob, this.hoverTip);

    const row = document.createElement("div");
    row.className = "pc-row";
    this.playBtn = button("Play", ICONS.play);
    const back = button("Back 10 seconds", ICONS.back);
    const fwd = button("Forward 10 seconds", ICONS.fwd);
    this.time = document.createElement("span");
    this.time.className = "pc-time";
    this.muteBtn = button("Mute", ICONS.volume);
    this.volume = document.createElement("input");
    this.volume.type = "range";
    this.volume.className = "pc-volume";
    this.volume.min = "0";
    this.volume.max = "1";
    this.volume.step = "0.01";
    this.volume.value = String(video.volume);
    this.volume.setAttribute("aria-label", "Volume");
    this.fsBtn = button("Fullscreen", ICONS.full);
    const spacer = document.createElement("span");
    spacer.className = "pc-spacer";
    row.append(this.playBtn, back, fwd, this.time, spacer, this.muteBtn, this.volume, this.fsBtn);
    controls.append(this.bar, row);

    this.root.append(this.status, this.bigPlay, controls);
    screen.append(this.root);

    this.playBtn.onclick = () => this.toggle();
    this.bigPlay.onclick = () => this.toggle();
    back.onclick = () => this.skip(-10);
    fwd.onclick = () => this.skip(10);
    this.muteBtn.onclick = () => {
      video.muted = !video.muted;
      this.renderVolume();
    };
    this.volume.oninput = () => {
      video.volume = Number(this.volume.value);
      video.muted = video.volume === 0;
      this.renderVolume();
    };
    this.fsBtn.onclick = () => this.toggleFullscreen();
    document.addEventListener("fullscreenchange", () =>
      setIcon(this.fsBtn, document.fullscreenElement ? ICONS.exit : ICONS.full, document.fullscreenElement ? "Exit fullscreen" : "Fullscreen"),
    );

    // Clicking the picture toggles playback; double-click goes fullscreen.
    video.addEventListener("click", () => this.toggle());
    video.addEventListener("dblclick", () => this.toggleFullscreen());

    this.bindSeekBar();
    this.bindKeys();
    for (const type of ["mousemove", "touchstart", "focusin"]) screen.addEventListener(type, () => this.wake());
    screen.addEventListener("mouseleave", () => this.sleepSoon(400));
    this.renderVolume();
    this.loop();
  }

  /** Message over the picture ("Connecting to the host"), or null to clear it. */
  setStatus(text: string | null): void {
    this.status.hidden = !text;
    this.status.textContent = text ?? "";
  }

  private toggle(): void {
    if (!this.source.canControl()) return this.flashLocked();
    this.source.toggle();
    this.wake();
  }

  private skip(delta: number): void {
    if (!this.source.canControl()) return this.flashLocked();
    const s = this.source.state();
    this.source.seek(Math.min(Math.max(0, s.position + delta), s.duration || Infinity));
    this.wake();
  }

  private flashLocked(): void {
    this.setStatus("The host controls playback");
    setTimeout(() => {
      if (this.status.textContent === "The host controls playback") this.setStatus(null);
    }, 1600);
  }

  private toggleFullscreen(): void {
    // The whole stage goes fullscreen, so the chat stays beside the video.
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.stage.requestFullscreen?.().catch(() => undefined);
  }

  private fraction(clientX: number): number {
    const r = this.bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }

  private bindSeekBar(): void {
    const duration = () => this.source.state().duration;
    this.bar.addEventListener("pointermove", (e) => {
      const f = this.fraction(e.clientX);
      this.hoverTip.textContent = formatTime(f * duration());
      this.hoverTip.style.left = `${f * 100}%`;
      if (this.dragging !== null) this.dragging = f;
    });
    this.bar.addEventListener("pointerdown", (e) => {
      if (!this.source.canControl()) return this.flashLocked();
      this.bar.setPointerCapture(e.pointerId);
      this.dragging = this.fraction(e.clientX);
    });
    const finish = () => {
      if (this.dragging === null) return;
      const f = this.dragging;
      this.dragging = null;
      this.source.seek(f * duration());
    };
    this.bar.addEventListener("pointerup", finish);
    this.bar.addEventListener("pointercancel", () => (this.dragging = null));
    this.bar.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        this.skip(e.key === "ArrowLeft" ? -5 : 5);
      }
    });
  }

  private bindKeys(): void {
    document.addEventListener("keydown", (e) => {
      const target = e.composedPath()[0] as HTMLElement | undefined;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "k") this.toggle();
      else if (k === "arrowleft" || k === "j") this.skip(k === "j" ? -10 : -5);
      else if (k === "arrowright" || k === "l") this.skip(k === "l" ? 10 : 5);
      else if (k === "m") this.muteBtn.click();
      else if (k === "f") this.toggleFullscreen();
      else return;
      e.preventDefault();
    });
  }

  private wake(): void {
    this.root.classList.remove("idle");
    this.screen.classList.remove("pc-hide-cursor");
    this.sleepSoon(IDLE_MS);
  }

  private sleepSoon(ms: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.source.state().playing || this.dragging !== null) return;
      this.root.classList.add("idle");
      this.screen.classList.add("pc-hide-cursor");
    }, ms);
  }

  private renderVolume(): void {
    const muted = this.video.muted || this.video.volume === 0;
    setIcon(this.muteBtn, muted ? ICONS.muted : ICONS.volume, muted ? "Unmute" : "Mute");
    this.volume.value = String(muted ? 0 : this.video.volume);
    this.volume.style.setProperty("--v", `${(muted ? 0 : this.video.volume) * 100}%`);
  }

  private loop(): void {
    const s = this.source.state();
    const f = this.dragging ?? (s.duration > 0 ? Math.min(1, s.position / s.duration) : 0);
    this.fill.style.width = `${f * 100}%`;
    this.knob.style.left = `${f * 100}%`;
    const shown = this.dragging !== null ? this.dragging * s.duration : s.position;
    this.time.textContent = s.duration > 0 ? `${formatTime(shown)} / ${formatTime(s.duration)}` : formatTime(shown);
    this.bar.setAttribute("aria-valuenow", String(Math.round(shown)));
    this.bar.setAttribute("aria-valuemax", String(Math.round(s.duration)));
    this.bar.setAttribute("aria-valuetext", `${formatTime(shown)} of ${formatTime(s.duration)}`);
    const playing = s.playing;
    if (this.playBtn.dataset.playing !== String(playing)) {
      this.playBtn.dataset.playing = String(playing);
      setIcon(this.playBtn, playing ? ICONS.pause : ICONS.play, playing ? "Pause" : "Play");
      this.bigPlay.hidden = playing;
      if (!playing) this.wake();
    }
    this.root.classList.toggle("locked", !this.source.canControl());
    this.raf = requestAnimationFrame(() => this.loop());
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.root.remove();
  }
}
