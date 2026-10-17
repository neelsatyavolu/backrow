// End-to-end encryption helpers. The room key lives only in the URL fragment
// (#...) and in the browser; the server only ever sees ciphertext.

const IV_BYTES = 12;

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("invalid base64url");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomId(length = 12): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function newKeyText(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function importKey(keyText: string): Promise<CryptoKey> {
  const raw = fromBase64Url(keyText);
  if (raw.length !== 32) throw new Error("room key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealJson(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv, 0);
  out.set(sealed, IV_BYTES);
  return toBase64Url(out);
}

/** Returns null when the blob is malformed or was not sealed with this key. */
export async function openJson(key: CryptoKey, blob: string): Promise<unknown | null> {
  try {
    const bytes = fromBase64Url(blob);
    if (bytes.length <= IV_BYTES) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) },
      key,
      bytes.subarray(IV_BYTES),
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}
