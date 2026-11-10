import type { PublicUser } from "@inkboard/shared/api";
import type { ClientToServerEvents, ServerToClientEvents } from "@inkboard/shared/socket";
import { Server } from "socket.io";
import type { Socket } from "socket.io";
import type { Role } from "../services/boards.ts";
import type { ExpiredGroup, HeldGroup } from "./operations.ts";
import type { Limiter } from "./rate-limit.ts";

// What a socket carries and hears: the shared event maps, with payloads as the handlers see them (unchecked).

// Payloads are unchecked, so handlers get them as Untrusted: every field unknown, the payload possibly missing.
export type Untrusted<Payload> = { [Field in keyof Payload]?: unknown } | null | undefined;

// A shared-map handler with an Untrusted payload; the ack may be missing, so handlers check for it.
type UntrustedHandler<Handler> = Handler extends () => void
  ? Handler
  : Handler extends (payload: infer Payload) => void
    ? (payload: Untrusted<Payload>) => void
    : Handler extends (payload: infer Payload, ack: infer Ack) => void
      ? (payload: Untrusted<Payload>, ack?: Ack) => void
      : never;

export type UntrustedClientEvents = {
  [Event in keyof ClientToServerEvents]: UntrustedHandler<ClientToServerEvents[Event]>;
};

export type InterServerEvents = Record<never, never>;

export interface SocketData {
  user: PublicUser | null;
  guest?: { id: string; name: string };
  // whom the memory held for unfinished groups counts against (see holdGroup)
  sender: string;
  // the database's id for the board, and the spelling the socket asked with (see isOnBoard)
  boardId?: string | null;
  requestedId?: string;
  // null until the first join sets it, which means no access
  role: Role | null;
  // the board's own role, before private mode turns editors into suggesters (see effectiveRole)
  boardRole?: Role | null;
  // the link-password pass the socket joined with (see link-pass.ts)
  pass?: string;
  // the browser merges by the older rules (see prepareOperation)
  legacy?: boolean;
  presenting?: boolean;
  // an embed on another site only views, and isn't shown to the others
  embed?: boolean;
  // unfinished piece-group and its idle timer (see holdGroup)
  heldGroup?: HeldGroup | ExpiredGroup | null;
  heldTimer?: ReturnType<typeof setTimeout> | null;
}

export type RealtimeServer = Server<UntrustedClientEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type RealtimeSocket = Socket<UntrustedClientEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export type SocketLimits = Record<string, Limiter>;
