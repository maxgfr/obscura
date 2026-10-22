/** What the room shows, kept apart from room.ts so the studio loads the room code only when used. */
import { signal } from "@preact/signals";

export const MAX_GUESTS = 3;
export const MAX_VIEWERS = 8;

export type Role = "guest" | "viewer";

export interface Peer {
  id: string;
  role: Role;
  name: string;
  state: "asking" | "connecting" | "connected";
  /** Answered by a code to copy back, instead of through the relays. */
  manual: boolean;
}

export type RoomState =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "on"; guestLink: string; viewerLink: string; relays: number; total: number };

export const room = signal<RoomState>({ kind: "off" });
export const peers = signal<Peer[]>([]);
