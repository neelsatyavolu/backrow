// Opt-in remote debug logging. Turned on from the extension's settings; batches
// trace lines and posts them to /api/log, where they land in Workers Logs.
// Only playback and connection details are sent: never chat, keys or names.

import { LOG_LIMITS } from "./protocol";

export interface LogEntry {
  t: number;
  msg: string;
  data?: string;
}

const FLUSH_MS = 4000;

export type RemoteLog = (msg: string, data?: unknown) => void;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Returns a logger that also echoes to the console, tagged with a per-tab session id. */
export function remoteLog(server: string, source: string): RemoteLog {
  const session = Math.random().toString(36).slice(2, 10);
  let queue: LogEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (!queue.length) return;
    const entries = queue;
    queue = [];
    void fetch(`${server}/api/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, source, entries }),
      keepalive: true,
    }).catch(() => undefined);
  };

  addEventListener("pagehide", flush);
  return (msg, data) => {
    console.debug("[backrow]", msg, data ?? "");
    const entry: LogEntry = { t: Date.now(), msg: clip(msg, LOG_LIMITS.msg) };
    if (data !== undefined) entry.data = clip(JSON.stringify(data) ?? "", LOG_LIMITS.data);
    queue = [...queue, entry].slice(-LOG_LIMITS.entries);
    timer ??= setTimeout(flush, FLUSH_MS);
  };
}
