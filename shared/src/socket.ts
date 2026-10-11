// The events between the browser and the server over Socket.IO. The server's handlers and emits and the browser's
// listeners and emits are checked against these, so a field renamed on one side stops the other from type checking.
// This file holds types only, so it adds nothing at run time.
//
// The payloads are written the way a well-behaved peer sends them. The server doesn't trust that (a browser can send
// anything, or nothing), and treats what it receives as unknown until it has looked (see Untrusted on the server).
// Like api.ts, the shapes have a `Date` where the server builds one, and what the other side receives has turned it
// into its ISO string (see Wire in api.ts).

import type { BoardMeta, BoardDetails, LinkLock, NotificationItem, Role, Thread } from "./api.ts";
import type { SYNC_FORMAT } from "./limits.ts";
import type { Suggestion, SuggestionDraft } from "./suggestions.ts";
import type { Effect, Element, Stamp } from "./types.ts";

// What the browser sends

/** The space limits an upload can break: a board's own, its owner's, or the whole app's. */
export type ImageLimit = "board" | "owner" | "total";

/** The label on a piece of a change sent in several: its group's id, its place in the group, and how many pieces there are. */
export interface PieceGroup {
  id: string;
  index: number;
  total: number;
}

/** What `board:join` sends: the board, and which rules the browser merges changes by (browsers that don't say are older). */
export interface JoinPayload {
  boardId: string;
  sync: typeof SYNC_FORMAT;
  /** The pass given for the link's password (see LinkPassReply), when it asks for one. */
  pass?: string;
}

/** What `board:op` sends: a change to the board, or one piece of a change sent in several (then with its `group`). */
export interface OpPayload {
  boardId: string;
  op: Effect;
  group?: PieceGroup;
}

/** What `board:image` sends: the picture, and a small copy of it for thumbnails if there is one. */
export interface ImagePayload {
  boardId: string;
  data: ArrayBuffer;
  small?: ArrayBuffer;
}

/** What `cursor` sends: where the pointer is on the board, or no position when it has left the board's view. */
export interface CursorPayload {
  x?: number;
  y?: number;
}

/** The part of the board someone is looking at: where it is, how far in, and how big their canvas is. */
export interface SharedView {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

/** What `viewport` sends: a view, and whose own view it is when it's one taken from someone they follow. */
export interface ViewportPayload extends SharedView {
  source?: string;
}

/** What `viewport:request` sends: the connection of the person to ask for their view. */
export interface ViewportRequestPayload {
  socketId: string;
}

/** What `guest:rename` sends: the guest's new name. */
export interface RenamePayload {
  name: string;
}

/** What `suggestion:put` sends: suggestions to make, or to replace the sender's own with (see SuggestionDraft). */
export interface SuggestionPutPayload {
  boardId: string;
  suggestions: SuggestionDraft[];
}

/** What `suggestion:withdraw` sends: the ids of the sender's own suggestions to take back. */
export interface SuggestionWithdrawPayload {
  boardId: string;
  ids: string[];
}

/** What a member decided about suggestions. Accepting one is the member's own change to the board, sent first. */
export type SuggestionOutcome = "accepted" | "rejected";

/** What `suggestion:resolve` sends: the ids of suggestions a member accepted or rejected. */
export interface SuggestionResolvePayload {
  boardId: string;
  ids: string[];
  outcome: SuggestionOutcome;
}

// What the browser hears back

/** A tombstone as a browser hears of it when it opens a board. */
export type RemovedStamp = Stamp & { id: string };

/**
 * The reply to joining a board: the board as this person may see it, with the stamps of what was removed lately,
 * and the suggestions open on it.
 */
export type JoinReply =
  | { ok: true; board: BoardDetails; removed: RemovedStamp[]; suggestions: Suggestion[] }
  | { ok: false; status: number; error: string; locked?: LinkLock };

/**
 * Why a change was refused. `tooLarge` and `readOnly` are also set where older browsers, which look for
 * them, need to see them. "rate", "noSession" (join the board first), "invalid", "tooLarge", "forbidden",
 * "expired" (the server stopped waiting for the rest of a change sent in pieces) and "ownerFull" (the board's
 * owner has no space left) are what `reason` can say.
 */
export interface OpRefusal {
  ok: false;
  reason: "rate" | "noSession" | "invalid" | "tooLarge" | "forbidden" | "expired" | "ownerFull";
  tooLarge?: true;
  readOnly?: true;
}

/** The reply to a change: taken in (with `cleaned`, elements as the board stored them where that isn't how they were sent, and `dropped`, ids of elements it refused), or refused. */
export type OpReply = { ok: true; cleaned?: Element[]; dropped?: string[] } | OpRefusal;

/** The reply to an image: the id it was stored under, or why it wasn't (`error` is a sentence for the person who tried). */
export type ImageReply =
  { ok: true; id: string } | { ok: false; error?: string; readOnly?: true; tooLarge?: true; full?: ImageLimit };

/**
 * Why suggestions were refused: "rate", "noSession" (join the board first), "forbidden" (the sender may not
 * do this on the board) or "invalid" (the payload isn't one).
 */
export interface SuggestionRefusal {
  ok: false;
  reason: "rate" | "noSession" | "forbidden" | "invalid";
}

/**
 * The reply to `suggestion:put`: the suggestions as the board keeps them; the ids of the sender's suggestions a
 * draft took back, by making an element just as it is on the board (`withdrawn`); and the element ids of drafts
 * it left out (`dropped`): ones that aren't valid, are about an element that isn't on the board (or, for an
 * addition, is), are someone else's, or didn't fit, in which case `full` says which limit they met.
 */
export type SuggestionPutReply =
  | { ok: true; suggestions: Suggestion[]; withdrawn?: string[]; dropped?: string[]; full?: "board" | "author" }
  | SuggestionRefusal;

/** The reply to `suggestion:withdraw` and `suggestion:resolve`: done (ids that aren't open are let be), or refused. */
export type SuggestionReply = { ok: true } | SuggestionRefusal;

// What the server sends

/** Someone on a board, as the others see them. A guest has no color or avatar. */
export interface Participant {
  userId: string;
  name: string;
  color?: string | null;
  avatarUrl?: string | null;
  guest: boolean;
}

/** A participant with the id of the connection they are on, which is what follows and pointers are told apart by. */
export type Peer = Participant & { socketId: string };

/** What an event about a board says of it: which board, so one meant for a board the browser has left can be told. */
export interface BoardMessage {
  boardId: string;
}

/** `board:revoked`: this person can't open the board any more. `locked` says when that's the link's password or expiry. */
export interface RevokedMessage extends BoardMessage {
  locked?: LinkLock;
}

/** What `board:op` carries: a change someone else made. */
export interface OpMessage extends BoardMessage {
  op: Effect;
}

/** What `board:reset` carries: everything on the board, replaced (someone restored an earlier version), and who did it. */
export interface ResetMessage extends BoardMessage {
  elements: Element[];
  removed: RemovedStamp[];
  by: string | null;
}

/** What `board:role` carries: what the person can do on the board now. */
export interface RoleMessage extends BoardMessage {
  role: Role;
}

/** What `cursor` carries: where someone's pointer is, or no position when it has left the board's view. */
export type CursorMessage = { socketId: string } & ({ x: number; y: number } | { x?: undefined; y?: undefined });

/** One person's view of the board, passed on to the others so they can follow along. */
export interface ViewportMessage extends SharedView, BoardMessage {
  socketId: string;
  /** Whose own view it is, when it's one taken from someone they follow. */
  source: string;
}

/** What `thread:delete` carries: the id of the thread that is gone. */
export interface ThreadRemoval {
  id: string;
}

/** What `suggestion:upsert` carries: suggestions made or changed, as the board keeps them. */
export interface SuggestionsMessage extends BoardMessage {
  suggestions: Suggestion[];
}

/**
 * What `suggestion:delete` carries: the ids of suggestions that are gone, and why: a member accepted or
 * rejected them, their author withdrew them, or what they were about is gone (removed, accepted another
 * way, or too old).
 */
export interface SuggestionRemovalMessage extends BoardMessage {
  ids: string[];
  outcome: SuggestionOutcome | "withdrawn" | "gone";
}

// The events

/** Everything a browser can send, and what it hears back. */
export interface ClientToServerEvents {
  "board:join": (payload: JoinPayload, ack: (reply: JoinReply) => void) => void;
  "board:leave": () => void;
  "board:op": (payload: OpPayload, ack: (reply: OpReply) => void) => void;
  "board:image": (payload: ImagePayload, ack: (reply: ImageReply) => void) => void;
  cursor: (payload: CursorPayload) => void;
  viewport: (payload: ViewportPayload) => void;
  "viewport:request": (payload: ViewportRequestPayload) => void;
  "guest:rename": (payload: RenamePayload) => void;
  "suggestion:put": (payload: SuggestionPutPayload, ack: (reply: SuggestionPutReply) => void) => void;
  "suggestion:withdraw": (payload: SuggestionWithdrawPayload, ack: (reply: SuggestionReply) => void) => void;
  "suggestion:resolve": (payload: SuggestionResolvePayload, ack: (reply: SuggestionReply) => void) => void;
}

/** What a browser is sent: changes made by others, who is there, and the board's own changes. */
export interface ServerToClientEvents {
  "board:op": (message: OpMessage) => void;
  "board:meta": (meta: BoardMeta) => void;
  "board:reset": (message: ResetMessage) => void;
  "board:revoked": (message: RevokedMessage) => void;
  "board:role": (message: RoleMessage) => void;
  "board:deleted": (message: BoardMessage) => void;
  // The board's id comes second, so browsers on an older app, which expect just the list, still read it.
  presence: (people: Peer[], board: BoardMessage) => void;
  cursor: (message: CursorMessage) => void;
  viewport: (message: ViewportMessage) => void;
  "viewport:request": (message: BoardMessage) => void;
  notification: (notification: NotificationItem) => void;
  // A comment thread as it is listed, or the id of one that is gone.
  "thread:upsert": (thread: Thread) => void;
  "thread:delete": (thread: ThreadRemoval) => void;
  "suggestion:upsert": (message: SuggestionsMessage) => void;
  "suggestion:delete": (message: SuggestionRemovalMessage) => void;
}
