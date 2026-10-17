// Per-browser conveniences for the web pages. Storage can be blocked
// (private windows), so every access falls back quietly.

import { AVATAR_COLORS, parseProfile, type Profile } from "../../shared/payload";

export function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not persisted; fine for a convenience.
  }
}

export function loadProfile(): Profile {
  try {
    const parsed = parseProfile(JSON.parse(load("backrow:profile") ?? "null"));
    if (parsed) return parsed;
  } catch {
    // fall through to a fresh profile
  }
  return { name: `Guest ${Math.floor(100 + Math.random() * 900)}`, color: Math.floor(Math.random() * AVATAR_COLORS.length) };
}

export function saveProfile(profile: Profile): void {
  store("backrow:profile", JSON.stringify(profile));
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Reads /<prefix>/<room>#<key> from the current URL. */
export function partyFromLocation(): { roomId: string; keyText: string } | null {
  const roomId = location.pathname.split("/").filter(Boolean)[1] ?? "";
  const keyText = location.hash.slice(1);
  if (!/^[a-z2-9]{12}$/.test(roomId) || !/^[A-Za-z0-9_-]{43}$/.test(keyText)) return null;
  return { roomId, keyText };
}
