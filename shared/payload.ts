// Shapes of the decrypted payloads inside wire blobs. Other members can send
// anything, so every payload is validated after decryption too.

import { parseVideoUrl, type VideoRef } from "./services";

export const AVATAR_COLORS = ["#4C8DFF", "#E5483A", "#4FBF85", "#E8A23B", "#C46BD6", "#3BC4C4", "#D6D06B", "#F2F0EA"];
export const REACTIONS = ["😂", "😮", "😍", "😢", "🔥", "👏", "💀", "🍿"] as const;
export const NAME_MAX = 24;
/** Longest profile photo data URL (a 64px WebP/JPEG is usually 2-5 KB). */
export const PHOTO_MAX = 8000;
export const CHAT_MAX = 500;

export interface Profile {
  name: string;
  color: number;
  /** Small square image as a data URL, if the person set one. */
  photo?: string;
}

export interface PlaybackState {
  playing: boolean;
  /** Seconds into the video at `at`. */
  position: number;
  rate: number;
  duration: number;
  /** Sender's estimate of server time (ms) when the position was read. */
  at: number;
}

export interface ChatText {
  text: string;
}

export interface Reaction {
  emoji: string;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
  return text.length > 0 && text.length <= max ? text : null;
}

export function cleanName(value: unknown): string | null {
  const text = cleanText(value, NAME_MAX * 2);
  return text ? text.replace(/\s+/g, " ").slice(0, NAME_MAX) : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseProfile(value: unknown): Profile | null {
  const o = obj(value);
  const name = cleanName(o?.name);
  const color = o?.color;
  if (!name || !Number.isInteger(color) || (color as number) < 0 || (color as number) >= AVATAR_COLORS.length) return null;
  const photo = o?.photo;
  // Raster images only: they are decoded into a canvas, never put in markup.
  const validPhoto =
    typeof photo === "string" && photo.length <= PHOTO_MAX && /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(photo);
  return validPhoto ? { name, color: color as number, photo } : { name, color: color as number };
}

export function parseState(value: unknown): PlaybackState | null {
  const o = obj(value);
  if (!o || typeof o.playing !== "boolean") return null;
  const { position, rate, duration, at } = o;
  if (!finite(position) || !finite(rate) || !finite(duration) || !finite(at)) return null;
  if (position < 0 || position > 864000 || rate < 0.25 || rate > 4 || duration < 0) return null;
  return { playing: o.playing, position, rate, duration, at };
}

export function parseChat(value: unknown): ChatText | null {
  const text = cleanText(obj(value)?.text, CHAT_MAX);
  return text ? { text } : null;
}

export function parseReaction(value: unknown): Reaction | null {
  const emoji = obj(value)?.emoji;
  return typeof emoji === "string" && (REACTIONS as readonly string[]).includes(emoji) ? { emoji } : null;
}

export function parseVideo(value: unknown): VideoRef | null {
  const o = obj(value);
  if (!o) return null;
  if (o.service === "local") {
    const name = cleanText(o.name, 200);
    return name ? { service: "local", name } : null;
  }
  if (typeof o.url !== "string") return null;
  const parsed = parseVideoUrl(o.url);
  if (!parsed || parsed.service !== o.service || parsed.id !== o.id) return null;
  const title = cleanText(o.title, 200);
  return title ? { ...parsed, title } : parsed;
}
