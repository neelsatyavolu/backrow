// Upload flow: encrypt the file chunk by chunk in this tab, upload the
// ciphertext to R2 through the Worker, then create a party pointing at it.

import { importKey, newKeyText, sealJson, toBase64Url } from "../../shared/crypto";
import {
  CHUNK_PLAIN,
  CHUNKS_PER_PART,
  MAX_UPLOAD_BYTES,
  chunkCount,
  importMediaKey,
  sealChunk,
} from "../../shared/media-crypto";
import type { UploadedVideo } from "../../shared/services";
import { store } from "./local";

const drop = document.getElementById("drop")!;
const input = document.getElementById("file") as HTMLInputElement;
const fileName = document.getElementById("fileName")!;
const fileMeta = document.getElementById("fileMeta")!;
const button = document.getElementById("upload") as HTMLButtonElement;
const hostOnly = document.getElementById("hostOnly") as HTMLInputElement;
const progressBox = document.getElementById("progressBox")!;
const bar = document.getElementById("bar")!;
const progress = document.getElementById("progress")!;
const errorEl = document.getElementById("error")!;

const PARALLEL_PARTS = 3;
let file: File | null = null;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n > 1024 * 1024 * 100 ? 0 : 1)} MB`;

function guessMime(f: File): string {
  if (f.type.startsWith("video/")) return f.type;
  const ext = f.name.split(".").pop()?.toLowerCase();
  return { webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", m4v: "video/mp4" }[ext ?? ""] ?? "video/mp4";
}

function pick(f: File | undefined): void {
  errorEl.textContent = "";
  if (!f) return;
  if (f.size > MAX_UPLOAD_BYTES) {
    errorEl.textContent = "That file is over 2 GB. Try a smaller or more compressed version.";
    return;
  }
  file = f;
  fileName.textContent = f.name;
  const playable = document.createElement("video").canPlayType(guessMime(f)) !== "";
  fileMeta.textContent = playable
    ? `${mb(f.size)} · ready to upload`
    : `${mb(f.size)} · this browser may not play this format. MP4 (H.264) is the safest choice.`;
  button.disabled = false;
}

input.addEventListener("change", () => pick(input.files?.[0]));
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  pick(e.dataTransfer?.files[0]);
});

async function api<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

async function sealPart(f: File, key: CryptoKey, part: number): Promise<Blob> {
  const total = chunkCount(f.size);
  const first = (part - 1) * CHUNKS_PER_PART;
  const last = Math.min(total, first + CHUNKS_PER_PART);
  const sealed: Uint8Array<ArrayBuffer>[] = [];
  for (let i = first; i < last; i++) {
    const plain = new Uint8Array(await f.slice(i * CHUNK_PLAIN, (i + 1) * CHUNK_PLAIN).arrayBuffer());
    sealed.push(await sealChunk(key, i, plain));
  }
  return new Blob(sealed);
}

async function upload(f: File): Promise<void> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const mediaKey = await importMediaKey(rawKey);
  const session = await api<{ mediaId: string; uploadId: string; token: string; parts: number }>("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ size: f.size }),
  });

  const qs = new URLSearchParams({ upload: session.uploadId, token: session.token, size: String(f.size) });
  const etags: Array<{ partNumber: number; etag: string }> = [];
  let done = 0;
  let next = 1;
  const started = Date.now();

  const worker = async () => {
    while (next <= session.parts) {
      const part = next++;
      const body = await sealPart(f, mediaKey, part);
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await api<{ partNumber: number; etag: string }>(`/api/uploads/${session.mediaId}/${part}?${qs}`, { method: "PUT", body });
          etags.push(res);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        }
      }
      if (lastError) throw lastError;
      done += body.size;
      const pct = Math.min(100, (done / f.size) * 100);
      const rate = done / Math.max(1, (Date.now() - started) / 1000);
      bar.style.width = `${pct}%`;
      progress.textContent = `Encrypting and uploading · ${pct.toFixed(0)}% · ${mb(rate)}/s`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, session.parts) }, worker));

  progress.textContent = "Finishing upload";
  await api("/api/uploads/" + session.mediaId + "/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId: session.uploadId, token: session.token, size: f.size, parts: etags.sort((a, b) => a.partNumber - b.partNumber) }),
  });

  const video: UploadedVideo = {
    service: "upload",
    id: session.mediaId,
    mediaKey: toBase64Url(rawKey),
    name: f.name.slice(0, 200),
    size: f.size,
    mime: guessMime(f),
  };
  const keyText = newKeyText();
  const blob = await sealJson(await importKey(keyText), video);
  const room = await api<{ roomId: string; hostKey: string }>("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video: blob, mediaId: session.mediaId }),
  });
  store(`backrow:host:${room.roomId}`, room.hostKey);
  if (hostOnly.checked) store(`backrow:hostonly:${room.roomId}`, "1");
  location.assign(`/watch/${room.roomId}#${keyText}`);
}

button.addEventListener("click", async () => {
  if (!file) return;
  button.disabled = true;
  input.disabled = true;
  errorEl.textContent = "";
  progressBox.hidden = false;
  progress.textContent = "Starting upload";
  try {
    await upload(file);
  } catch (err) {
    errorEl.textContent = err instanceof Error ? err.message : "Upload failed. Try again.";
    progressBox.hidden = true;
    button.disabled = false;
    input.disabled = false;
  }
});

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-copy]"))) {
  b.addEventListener("click", async () => {
    const label = b.querySelector("span");
    try {
      await navigator.clipboard.writeText(b.dataset.copy ?? "");
      if (label) label.textContent = "Copied";
    } catch {
      if (label) label.textContent = "Select and copy";
    }
    setTimeout(() => label && (label.textContent = "Copy"), 1600);
  });
}
