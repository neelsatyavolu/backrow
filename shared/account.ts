// Accounts keep a profile (name, color, photo) on every device. The password
// never leaves the browser: it is stretched into two keys, one that proves who
// you are to the server and one that encrypts the profile. The server stores
// only the first (hashed) and the encrypted profile, so it can't read either
// the password or the profile.

import { fromBase64Url, importKey, openJson, sealJson, toBase64Url } from "./crypto";
import { parseProfile, type Profile } from "./payload";

export const PASSWORD_MIN = 8;
export const EMAIL_MAX = 254;
/** Largest sealed profile the server accepts (a full photo seals to about 11 KB). */
export const PROFILE_BLOB_MAX = 16000;
const PBKDF2_ROUNDS = 600_000;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** A derived auth key: 32 bytes, base64url. */
export const isAuthKey = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
export const isCode = (v: unknown): v is string => typeof v === "string" && /^\d{6}$/.test(v);
export const isProfileBlob = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= PROFILE_BLOB_MAX && /^[A-Za-z0-9_-]+$/.test(v);

export interface AccountKeys {
  /** Sent to the server in place of the password. */
  auth: string;
  /** Encrypts the profile; stays in the browser. */
  key: string;
}

async function hkdf(master: CryptoKey, info: string): Promise<string> {
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    master,
    256,
  );
  return toBase64Url(new Uint8Array(bits));
}

export async function deriveKeys(email: string, password: string): Promise<AccountKeys> {
  const enc = new TextEncoder();
  const pass = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(`backrow-account:${email}`), iterations: PBKDF2_ROUNDS },
    pass,
    256,
  );
  const master = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits"]);
  return { auth: await hkdf(master, "backrow auth"), key: await hkdf(master, "backrow profile") };
}

export async function sealProfile(key: string, profile: Profile): Promise<string> {
  return sealJson(await importKey(key), profile);
}

/** Null when the blob can't be opened with this key (e.g. after a password reset). */
export async function openProfile(key: string, blob: string): Promise<Profile | null> {
  return parseProfile(await openJson(await importKey(key), blob));
}

export interface SavedAccount {
  email: string;
  token: string;
  key: string;
}

export function parseSavedAccount(value: unknown): SavedAccount | null {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const email = normalizeEmail(o?.email);
  if (!email || typeof o?.token !== "string" || typeof o.key !== "string") return null;
  try {
    if (fromBase64Url(o.key).length !== 32) return null;
  } catch {
    return null;
  }
  return { email, token: o.token, key: o.key };
}

export class AccountError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Body = Record<string, unknown>;

export class AccountApi {
  constructor(private readonly server: string) {}

  private async call<T>(method: string, path: string, body?: Body, token?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.server}/api/account/${path}`, {
        method,
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new AccountError("Can't reach Backrow. Check your connection.", 0);
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new AccountError(data.error ?? "Something went wrong", res.status);
    return data;
  }

  /** Emails a 6-digit code. `devCode` is only returned by a local dev server. */
  signup(email: string, auth: string) {
    return this.call<{ ok: true; devCode?: string }>("POST", "signup", { email, auth });
  }
  verify(email: string, code: string) {
    return this.call<{ token: string }>("POST", "verify", { email, code });
  }
  login(email: string, auth: string) {
    return this.call<{ token: string }>("POST", "login", { email, auth });
  }
  requestReset(email: string) {
    return this.call<{ ok: true; devCode?: string }>("POST", "reset-request", { email });
  }
  reset(email: string, code: string, auth: string) {
    return this.call<{ token: string }>("POST", "reset", { email, code, auth });
  }
  logout(token: string) {
    return this.call<{ ok: true }>("POST", "logout", undefined, token);
  }
  getProfile(token: string) {
    return this.call<{ profile: string | null }>("GET", "profile", undefined, token);
  }
  putProfile(token: string, profile: string) {
    return this.call<{ ok: true }>("PUT", "profile", { profile }, token);
  }
  remove(token: string) {
    return this.call<{ ok: true }>("DELETE", "", undefined, token);
  }
}

/**
 * Brings this device and the account into line after signing in: the
 * account's profile wins if it has one, otherwise this device's is uploaded.
 * Returns the profile to use.
 */
export async function syncOnSignIn(api: AccountApi, account: SavedAccount, local: Profile): Promise<Profile> {
  const { profile } = await api.getProfile(account.token);
  const remote = profile ? await openProfile(account.key, profile) : null;
  if (remote) return remote;
  await api.putProfile(account.token, await sealProfile(account.key, local));
  return local;
}

/** Uploads a changed profile. Returns false when the session is no longer valid. */
export async function pushProfile(api: AccountApi, account: SavedAccount, profile: Profile): Promise<boolean> {
  try {
    await api.putProfile(account.token, await sealProfile(account.key, profile));
    return true;
  } catch (err) {
    if (err instanceof AccountError && err.status === 401) return false;
    throw err;
  }
}

/** The account's current profile, or null if it has none or the session ended. */
export async function pullProfile(api: AccountApi, account: SavedAccount): Promise<{ profile: Profile | null; signedOut: boolean }> {
  try {
    const { profile } = await api.getProfile(account.token);
    return { profile: profile ? await openProfile(account.key, profile) : null, signedOut: false };
  } catch (err) {
    if (err instanceof AccountError && err.status === 401) return { profile: null, signedOut: true };
    throw err;
  }
}
