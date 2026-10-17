// Messages between the extension's background worker, content scripts and popup.

import type { PartyEvent, RoomSnapshot } from "../../shared/party-client";
import type { PlaybackState, Profile } from "../../shared/payload";
import type { ControlMode } from "../../shared/protocol";
import type { StreamingVideo, VideoRef } from "../../shared/services";

declare const __BACKROW_SERVER__: string;
export const SERVER = __BACKROW_SERVER__;

export interface SessionInfo {
  roomId: string;
  invite: string;
  snapshot: RoomSnapshot | null;
  status: string;
  offset: number;
}

/** Content script -> background, over the "party" port. */
export type PortIn =
  | { type: "here"; video: StreamingVideo | null }
  | { type: "state"; state: Omit<PlaybackState, "at"> }
  | { type: "video"; video: VideoRef }
  | { type: "chat"; text: string }
  | { type: "react"; emoji: string }
  | { type: "typing"; on: boolean }
  | { type: "control"; mode: ControlMode }
  | { type: "profile"; profile: Profile }
  | { type: "leave" };

/** Background -> content script. */
export type PortOut =
  | { type: "session"; session: SessionInfo | null; profile: Profile }
  | { type: "event"; event: PartyEvent; offset: number };

/** Popup / join bridge -> background, via runtime.sendMessage. */
export type RuntimeIn =
  | { type: "popup-status"; tabId: number }
  | { type: "start"; tabId: number; hostOnly: boolean }
  | { type: "leave"; tabId: number }
  | { type: "get-profile" }
  | { type: "set-profile"; profile: Profile }
  | { type: "join"; roomId: string; keyText: string; url: string };

export interface PopupStatus {
  supported: boolean;
  video: StreamingVideo | null;
  session: SessionInfo | null;
  profile: Profile;
}

export const inviteUrl = (roomId: string, keyText: string) => `${SERVER}/p/${roomId}#${keyText}`;
