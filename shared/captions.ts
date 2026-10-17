// Caption files (SRT or WebVTT) the host adds to a local video. Only timing
// and plain text are kept: styling, positions and markup are dropped, and the
// text is always shown with textContent.

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Caption files bigger than this are refused (a feature film is ~100 KB). */
export const MAX_CAPTION_BYTES = 2_000_000;

// "01:02:03,456", "01:02:03.456" or WebVTT's short "02:03.456".
const TIME = String.raw`(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})`;
const TIMING = new RegExp(`^\\s*${TIME}\\s*-->\\s*${TIME}`);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function seconds(h: string | undefined, m: string, s: string, ms: string): number {
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

function cleanLine(line: string): string {
  return line
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&(#\d+|[a-z]+);/gi, (m, name: string) =>
      name.startsWith("#") ? String.fromCodePoint(Number(name.slice(1)) || 32) : (ENTITIES[name.toLowerCase()] ?? m),
    )
    .trim();
}

export function parseCaptions(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => TIMING.test(l));
    const t = at < 0 ? null : lines[at]!.match(TIMING);
    if (!t) continue;
    const [, h1, m1 = "", s1 = "", ms1 = "", h2, m2 = "", s2 = "", ms2 = ""] = t;
    const start = seconds(h1, m1, s1, ms1);
    const end = seconds(h2, m2, s2, ms2);
    const body = lines.slice(at + 1).map(cleanLine).filter(Boolean).join("\n");
    if (body && end > start) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Cues on screen at `position` seconds, in start order. */
export function activeCues(cues: Cue[], position: number): Cue[] {
  return cues.filter((c) => c.start <= position && position < c.end);
}

/** Older SRT files are often Windows-1252 rather than UTF-8. */
export function decodeCaptions(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
