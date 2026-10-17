// Profile photos: shrunk to a small square in the browser, sent encrypted like
// the rest of the profile, and drawn on a <canvas> rather than an <img>, so a
// streaming site's Content Security Policy (img-src) can't block them.

import { PHOTO_MAX } from "../payload";

const SIZE = 64;

/** Center-crops an image file to a small square data URL that fits PHOTO_MAX. */
export async function fileToAvatar(file: Blob): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 20 * 1024 * 1024) throw new Error("That image is over 20 MB.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That image couldn't be read. Try a JPEG or PNG.");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't process images.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    // Safari can't encode WebP and silently returns PNG, so fall back to JPEG.
    let url = canvas.toDataURL("image/webp", quality);
    if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= PHOTO_MAX) return url;
  }
  throw new Error("That image is too detailed to use. Try another one.");
}

const decoded = new Map<string, Promise<ImageBitmap | null>>();

function bitmapFor(dataUrl: string): Promise<ImageBitmap | null> {
  let hit = decoded.get(dataUrl);
  if (!hit) {
    hit = (async () => {
      try {
        const comma = dataUrl.indexOf(",");
        const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
        const bin = atob(dataUrl.slice(comma + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return await createImageBitmap(new Blob([bytes], { type: mime }));
      } catch {
        return null;
      }
    })();
    decoded.set(dataUrl, hit);
    if (decoded.size > 200) decoded.delete(decoded.keys().next().value!);
  }
  return hit;
}

/** A canvas showing the photo, cropped to a circle by CSS. */
export function photoCanvas(dataUrl: string, className: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  canvas.className = className;
  void bitmapFor(dataUrl).then((bmp) => {
    if (bmp) canvas.getContext("2d")?.drawImage(bmp, 0, 0, SIZE, SIZE);
  });
  return canvas;
}
