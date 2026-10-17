// One Durable Object per party. Uses WebSocket hibernation so an idle party
// costs nothing, and deletes itself (and any uploaded video) once empty.

import { DurableObject } from "cloudflare:workers";
import { randomId } from "../../shared/crypto";
import { LIMITS, parseClientMessage, type ServerMessage } from "../../shared/protocol";
import { handle, leave, newRoom, takeToken, type Bucket, type Conn, type Out, type RoomData } from "./room-logic";
import type { Env } from "./env";

const EMPTY_TTL_MS = 6 * 60 * 60 * 1000;

export class Room extends DurableObject<Env> {
  private room: RoomData | null | undefined;
  private buckets = new WeakMap<WebSocket, Bucket>();

  private async load(): Promise<RoomData | null> {
    if (this.room === undefined) this.room = (await this.ctx.storage.get<RoomData>("room")) ?? null;
    return this.room;
  }

  private async save(room: RoomData): Promise<void> {
    if (room === this.room) return;
    this.room = room;
    await this.ctx.storage.put("room", room);
  }

  private conns(except?: WebSocket): Array<{ ws: WebSocket; conn: Conn }> {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== except)
      .map((ws) => ({ ws, conn: ws.deserializeAttachment() as Conn }))
      .filter((c) => c.conn);
  }

  private deliver(self: WebSocket, out: Out[]): void {
    for (const { to, msg } of out) {
      const text = JSON.stringify(msg);
      const targets =
        to === "self" ? [self] : this.conns(to === "others" ? self : undefined).filter((c) => c.conn.profile).map((c) => c.ws);
      for (const ws of targets) {
        try {
          ws.send(text);
        } catch {
          // Socket already gone; its close handler cleans up.
        }
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/create" && request.method === "POST") {
      if (await this.load()) return Response.json({ error: "exists" }, { status: 409 });
      const body = (await request.json()) as { video: string; mediaId: string | null };
      const room = newRoom(body.video, body.mediaId, Date.now());
      await this.save(room);
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_TTL_MS);
      return Response.json({ hostKey: room.hostKey });
    }

    const room = await this.load();
    if (!room) return Response.json({ error: "not-found" }, { status: 404 });

    if (url.pathname === "/info") {
      const members = this.conns().filter((c) => c.conn.profile).length;
      return Response.json({ video: room.video, members, upload: room.mediaId !== null });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      if (this.conns().length >= LIMITS.members) return new Response("Party is full", { status: 403 });
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      const conn: Conn = { id: randomId(8), joinedAt: Date.now(), profile: null, ownsHostKey: false };
      server.serializeAttachment(conn);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const limited = takeToken(this.buckets.get(ws), Date.now());
    this.buckets.set(ws, limited.bucket);
    if (!limited.ok) {
      this.deliver(ws, [{ to: "self", msg: { t: "error", code: "slow-down", message: "Too many messages" } }]);
      return;
    }
    const msg = parseClientMessage(typeof data === "string" ? data : null);
    const room = await this.load();
    const conn = ws.deserializeAttachment() as Conn | null;
    if (!msg || !room || !conn) {
      const err: ServerMessage = { t: "error", code: "bad-message", message: "Malformed message" };
      ws.send(JSON.stringify(err));
      return;
    }
    const others = this.conns(ws).map((c) => c.conn);
    const result = handle(room, conn, msg, others, Date.now());
    if (result.conn !== conn) ws.serializeAttachment(result.conn);
    await this.save(result.room);
    this.deliver(ws, result.out);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.drop(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.drop(ws);
  }

  private async drop(ws: WebSocket): Promise<void> {
    const room = await this.load();
    const gone = ws.deserializeAttachment() as Conn | null;
    if (!room || !gone) return;
    ws.serializeAttachment(null);
    const remaining = this.conns(ws).map((c) => c.conn);
    const result = leave(room, gone, remaining);
    await this.save(result.room);
    this.deliver(ws, result.out.map((o) => ({ ...o, to: "others" as const })));
    if (remaining.length === 0) await this.ctx.storage.setAlarm(Date.now() + EMPTY_TTL_MS);
  }

  async alarm(): Promise<void> {
    if (this.conns().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_TTL_MS);
      return;
    }
    const room = await this.load();
    if (room?.mediaId) {
      await this.env.MEDIA.delete(`media/${room.mediaId}`);
      await this.env.QUOTA.getByName("global").release(room.mediaId);
    }
    await this.ctx.storage.deleteAll();
    this.room = null;
  }
}
