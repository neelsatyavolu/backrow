import { describe, expect, it } from "vitest";
import { handle, leave, newRoom, takeToken, type Conn } from "../worker/src/room-logic";

const blob = "B".repeat(40);
const conn = (id: string, joinedAt = 1): Conn => ({ id, joinedAt, profile: null, ownsHostKey: false });

function join(room: ReturnType<typeof newRoom>, c: Conn, others: Conn[], hostKey?: string) {
  return handle(room, c, hostKey ? { t: "hello", profile: blob, hostKey } : { t: "hello", profile: blob }, others, 100);
}

describe("room logic", () => {
  it("requires hello before anything else", () => {
    const room = newRoom(blob, null, 0);
    const r = handle(room, conn("a"), { t: "chat", blob }, [], 1);
    expect(r.out[0]?.msg).toMatchObject({ t: "error", code: "hello-first" });
  });

  it("makes the host-key holder host and welcomes them", () => {
    const room = newRoom(blob, null, 0);
    const r = join(room, conn("a"), [], room.hostKey);
    expect(r.room.host).toBe("a");
    expect(r.out[0]?.msg).toMatchObject({ t: "welcome", you: "a", host: "a", video: blob });
    expect(r.out[1]).toMatchObject({ to: "others", msg: { t: "join" } });
  });

  it("enforces host-only control", () => {
    let room = newRoom(blob, null, 0);
    const host = join(room, conn("h"), [], room.hostKey);
    room = host.room;
    const guest = join(room, conn("g", 2), [host.conn]);
    room = handle(room, host.conn, { t: "control", mode: "host" }, [guest.conn], 5).room;
    expect(room.control).toBe("host");
    const denied = handle(room, guest.conn, { t: "state", blob }, [host.conn], 6);
    expect(denied.room.state).toBeNull();
    expect(denied.out[0]?.msg).toMatchObject({ t: "error", code: "host-only" });
    const ok = handle(room, host.conn, { t: "state", blob }, [guest.conn], 7);
    expect(ok.room.state).toEqual({ blob, by: "h", at: 7 });
    const notHost = handle(room, guest.conn, { t: "control", mode: "everyone" }, [host.conn], 8);
    expect(notHost.room.control).toBe("host");
  });

  it("keeps chat history bounded and broadcasts to all", () => {
    let room = newRoom(blob, null, 0);
    const a = join(room, conn("a"), []);
    room = a.room;
    for (let i = 0; i < 200; i++) room = handle(room, a.conn, { t: "chat", blob }, [], i).room;
    expect(room.chat).toHaveLength(150);
    expect(handle(room, a.conn, { t: "chat", blob }, [], 1).out[0]?.to).toBe("all");
  });

  it("hands host to the earliest member when the host leaves", () => {
    let room = newRoom(blob, null, 0);
    const h = join(room, conn("h", 1), [], room.hostKey);
    room = h.room;
    const g1 = join(room, conn("g1", 2), [h.conn]);
    const g2 = join(g1.room, conn("g2", 3), [h.conn, g1.conn]);
    const left = leave(g2.room, h.conn, [g1.conn, g2.conn]);
    expect(left.room.host).toBe("g1");
    // The original host reclaims it on rejoin.
    const back = join(left.room, conn("h2", 9), [g1.conn, g2.conn], room.hostKey);
    expect(back.room.host).toBe("h2");
  });

  it("rate limits bursts", () => {
    let bucket;
    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      const r = takeToken(bucket, 1000);
      bucket = r.bucket;
      if (r.ok) allowed++;
    }
    expect(allowed).toBe(30);
    expect(takeToken(bucket, 2000).ok).toBe(true);
  });
});
