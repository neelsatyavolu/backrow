import type { Room } from "./room";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  CREATE_LIMITER: RateLimit;
  /** Optional Cloudflare TURN key, for peers that can't connect directly. */
  TURN_KEY_ID?: string;
  TURN_KEY_TOKEN?: string;
}
