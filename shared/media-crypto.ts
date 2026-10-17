// Chunked AES-GCM for uploaded videos. Each 1 MiB plaintext chunk is sealed on
// its own so the player can decrypt any byte range without the whole file.
// The IV is the chunk index: safe because every file gets a fresh random key
// and each index is encrypted exactly once.

export const CHUNK_PLAIN = 1024 * 1024;
export const TAG_BYTES = 16;
export const CHUNK_SEALED = CHUNK_PLAIN + TAG_BYTES;
/** Chunks per multipart part. R2 needs parts >= 5 MiB except the last. */
export const CHUNKS_PER_PART = 8;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export function chunkCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / CHUNK_PLAIN));
}

export function sealedSize(plainSize: number): number {
  return plainSize + chunkCount(plainSize) * TAG_BYTES;
}

export function partCount(plainSize: number): number {
  return Math.ceil(chunkCount(plainSize) / CHUNKS_PER_PART);
}

/** Sealed byte span [start, endInclusive] that holds plaintext chunks first..last. */
export function sealedSpan(first: number, last: number, plainSize: number): [number, number] {
  const end = Math.min((last + 1) * CHUNK_SEALED, sealedSize(plainSize)) - 1;
  return [first * CHUNK_SEALED, end];
}

function ivFor(index: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}

export async function importMediaKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealChunk(key: CryptoKey, index: number, plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivFor(index) }, key, plain);
  return new Uint8Array(out);
}

export async function openChunk(key: CryptoKey, index: number, sealed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivFor(index) }, key, sealed);
  return new Uint8Array(out);
}
