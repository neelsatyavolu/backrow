// Keeps total stored uploads under a cap so the project stays inside
// Cloudflare R2's free tier. Objects also expire through a bucket lifecycle
// rule, so entries here age out on the same schedule.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export const QUOTA_BYTES = 8 * 1024 * 1024 * 1024;
export const UPLOAD_LIFETIME_MS = 26 * 60 * 60 * 1000;

interface Entry {
  size: number;
  expires: number;
}

export class Quota extends DurableObject<Env> {
  private async live(now: number): Promise<Map<string, Entry>> {
    const all = await this.ctx.storage.list<Entry>({ prefix: "m:" });
    const expired = [...all].filter(([, e]) => e.expires <= now).map(([k]) => k);
    if (expired.length) await this.ctx.storage.delete(expired);
    return new Map([...all].filter(([, e]) => e.expires > now));
  }

  async reserve(mediaId: string, size: number): Promise<boolean> {
    const now = Date.now();
    const used = [...(await this.live(now)).values()].reduce((sum, e) => sum + e.size, 0);
    if (used + size > QUOTA_BYTES) return false;
    await this.ctx.storage.put<Entry>(`m:${mediaId}`, { size, expires: now + UPLOAD_LIFETIME_MS });
    return true;
  }

  async release(mediaId: string): Promise<void> {
    await this.ctx.storage.delete(`m:${mediaId}`);
  }
}
