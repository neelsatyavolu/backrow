import type { Quota } from "./quota";
import type { Room } from "./room";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  QUOTA: DurableObjectNamespace<Quota>;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  CREATE_LIMITER: RateLimit;
  UPLOAD_LIMITER: RateLimit;
  /** HMAC secret that signs upload sessions. Set with `wrangler secret put UPLOAD_SECRET`. */
  UPLOAD_SECRET: string;
}
