// Per-browser conveniences for the web pages. Storage can be blocked
// (private windows), so every access falls back quietly.

import { AccountApi, parseSavedAccount, pullProfile, pushProfile, type SavedAccount } from "../../shared/account";
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

export const accountApi = new AccountApi(location.origin);

export function loadAccount(): SavedAccount | null {
  try {
    return parseSavedAccount(JSON.parse(load("backrow:account") ?? "null"));
  } catch {
    return null;
  }
}

export function saveAccount(account: SavedAccount | null): void {
  if (account) store("backrow:account", JSON.stringify(account));
  else {
    try {
      localStorage.removeItem("backrow:account");
    } catch {
      // Nothing stored.
    }
  }
}

/** Remembers the profile here and, when signed in, saves it to the account. */
export function saveProfile(profile: Profile, upload = true): void {
  store("backrow:profile", JSON.stringify(profile));
  const account = upload ? loadAccount() : null;
  if (!account) return;
  pushProfile(accountApi, account, profile)
    .then((ok) => ok || saveAccount(null))
    .catch((err) => console.error("[backrow] saving profile to account failed", err));
}

/** Picks up a profile changed on another device, giving up after a moment so pages don't wait on it. */
export async function pullAccountProfile(timeoutMs = 2500): Promise<void> {
  const account = loadAccount();
  if (!account) return;
  const pull = pullProfile(accountApi, account).then(({ profile, signedOut }) => {
    if (signedOut) saveAccount(null);
    if (profile) saveProfile(profile, false);
  });
  await Promise.race([pull.catch(() => undefined), new Promise((r) => setTimeout(r, timeoutMs))]);
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
