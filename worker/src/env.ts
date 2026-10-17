import type { Room } from "./room";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  CREATE_LIMITER: RateLimit;
  AUTH_LIMITER: RateLimit;
  /** Accounts: users, pending email codes and sessions. */
  DB: D1Database;
  /** Resend key for account emails. */
  RESEND_API_KEY?: string;
  /** "1" in .dev.vars only: return email codes in responses instead of sending them. */
  DEV_CODES?: string;
  /** Optional Cloudflare TURN key, for peers that can't connect directly. */
  TURN_KEY_ID?: string;
  TURN_KEY_TOKEN?: string;
}
