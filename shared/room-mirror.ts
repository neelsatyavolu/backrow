// Folds party events into a room snapshot, for views that only see the events.

import type { PartyEvent, RoomSnapshot } from "./party-client";

export function applyEvent(snap: RoomSnapshot | null, e: PartyEvent): RoomSnapshot | null {
  if (e.type === "snapshot") return e.snapshot;
  if (!snap) return null;
  switch (e.type) {
    case "member-join":
      return { ...snap, members: [...snap.members.filter((m) => m.id !== e.member.id), e.member] };
    case "member-leave":
      return { ...snap, members: snap.members.filter((m) => m.id !== e.member.id) };
    case "member-update":
      return { ...snap, members: snap.members.map((m) => (m.id === e.member.id ? e.member : m)) };
    case "state":
      return { ...snap, state: { ...e.state, by: e.by.id } };
    case "video":
      return { ...snap, video: e.video, state: null };
    case "chat":
      return { ...snap, chat: [...snap.chat, e.entry].slice(-150) };
    case "control":
      return { ...snap, control: e.mode };
    case "host":
      return { ...snap, host: e.id };
    default:
      return snap;
  }
}
