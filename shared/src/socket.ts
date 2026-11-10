// The events between browser and server over Socket.IO, checked on both sides so a renamed field stops the other from type
// checking. Types only. Payloads are what a well-behaved peer sends; the server treats what it receives as unknown (see
// Untrusted on the server). Like api.ts, a `Date` here is an ISO string on the receiving side (see Wire in api.ts).

import type { BoardMeta, BoardDetails, LinkLock, NotificationItem, Role, Thread } from "./api.ts";
import type { SYNC_FORMAT } from "./limits.ts";
import type { Suggestion, SuggestionDraft } from "./suggestions.ts";
import type { Effect, Element, Stamp } from "./types.ts";

export type ImageLimit = "board" | "owner" | "total";

export interface PieceGroup {
  id: string;
  index: number;
  total: number;
}

export interface JoinPayload {
  boardId: string;
  sync: typeof SYNC_FORMAT;
  pass?: string;
  presenting?: boolean;
  embed?: boolean;
}

export interface OpPayload {
  boardId: string;
  op: Effect;
  group?: PieceGroup;
}

export interface ImagePayload {
  boardId: string;
  data: ArrayBuffer;
  small?: ArrayBuffer;
}

export interface CursorPayload {
  x?: number;
  y?: number;
  laser?: boolean;
}

export interface PresentPayload {
  on: boolean;
}

// only someone who can edit the board may
export type CountdownPayload = { action: "start"; seconds: number } | { action: "pause" | "resume" | "stop" };

export interface PrivatePayload {
  on: boolean;
}

export interface SharedView {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export interface ViewportPayload extends SharedView {
  source?: string;
}

export interface ViewportRequestPayload {
  socketId: string;
}

// An editor starts a round with `votes` for each person (at most MAX_VOTES_PER_PERSON), ends it (which shows everyone the results), or clears it; anyone on the board votes on an element, one each at most, while it's open.
export type VotePayload =
  { action: "start"; votes: number } | { action: "end" | "clear" } | { action: "cast" | "retract"; id: string };

export interface RenamePayload {
  name: string;
}

export interface SuggestionPutPayload {
  boardId: string;
  suggestions: SuggestionDraft[];
}

export interface SuggestionWithdrawPayload {
  boardId: string;
  ids: string[];
}

export interface ReplayPayload {
  boardId: string;
}

export type SuggestionOutcome = "accepted" | "rejected";

export interface SuggestionResolvePayload {
  boardId: string;
  ids: string[];
  outcome: SuggestionOutcome;
}

export type RemovedStamp = Stamp & { id: string };

export type JoinReply =
  | {
      ok: true;
      board: BoardDetails;
      removed: RemovedStamp[];
      suggestions: Suggestion[];
      countdown?: Countdown | null;
      privateMode?: PrivateMode | null;
      classroom?: Classroom | null;
    }
  | { ok: false; status: number; error: string; locked?: LinkLock };

// `tooLarge` and `readOnly` are also set for older browsers, which look for them. "expired": the server stopped waiting for the rest of a change sent in pieces; "ownerFull": the owner has no space left; "outside": classroom mode, a change outside the student's frame.
export interface OpRefusal {
  ok: false;
  reason: "rate" | "noSession" | "invalid" | "tooLarge" | "forbidden" | "expired" | "ownerFull" | "outside";
  tooLarge?: true;
  readOnly?: true;
}

// `cleaned`: elements as the board stored them where that isn't how they were sent; `dropped`: ids of new elements it refused. In classroom mode what a student changed outside their frame is left out (`outside`): those changes come back in `cleaned`, new elements in `dropped`, removed ones in `restored`, as the board has them.
export type OpReply =
  { ok: true; cleaned?: Element[]; dropped?: string[]; restored?: Element[]; outside?: true } | OpRefusal;

export interface ReplayStep {
  at: number;
  upsert: Element[];
  remove: string[];
}

export type ReplayReply = { ok: true; steps: ReplayStep[]; elements: Element[] } | { ok: false; error: string };

export type ImageReply =
  { ok: true; id: string } | { ok: false; error?: string; readOnly?: true; tooLarge?: true; full?: ImageLimit };

// "noSession": join the board first; "forbidden": the sender may not do this on the board; "invalid": the payload isn't one
export interface SuggestionRefusal {
  ok: false;
  reason: "rate" | "noSession" | "forbidden" | "invalid";
}

// `withdrawn`: the sender's suggestions a draft took back by making an element just as it is on the board; `dropped`: element ids of drafts left out (invalid, about an element that isn't on the board (or, for an addition, is), someone else's, or too many, in which case `full` says which limit they met)
export type SuggestionPutReply =
  | { ok: true; suggestions: Suggestion[]; withdrawn?: string[]; dropped?: string[]; full?: "board" | "author" }
  | SuggestionRefusal;

export type SuggestionReply = { ok: true } | SuggestionRefusal;

export interface Participant {
  userId: string;
  name: string;
  color?: string | null;
  avatarUrl?: string | null;
  guest: boolean;
}

export type Peer = Participant & { socketId: string; presenting?: boolean };

export interface BoardMessage {
  boardId: string;
}

export interface RevokedMessage extends BoardMessage {
  locked?: LinkLock;
}

export interface OpMessage extends BoardMessage {
  op: Effect;
}

export interface ResetMessage extends BoardMessage {
  elements: Element[];
  removed: RemovedStamp[];
  by: string | null;
}

export interface RoleMessage extends BoardMessage {
  role: Role;
}

export type CursorMessage = { socketId: string } & (
  { x: number; y: number; laser?: true } | { x?: undefined; y?: undefined; laser?: undefined }
);

// time left rather than an end time, so a browser whose clock is wrong still counts down right
export interface Countdown {
  total: number;
  left: number;
  running: boolean;
}

export interface CountdownMessage extends BoardMessage {
  countdown: Countdown | null;
}

// while it's on, what everyone but `by` draws is a suggestion only they see, until it's turned off and all of it is shown
export interface PrivateMode {
  by: string;
  canEnd: boolean;
}

export type ClassroomPayload = { action: "start" | "stop" } | { action: "claim" | "release"; frameId: string };

export interface FrameClaim {
  frameId: string;
  name: string;
  mine: boolean;
}

export interface Classroom {
  on: boolean;
  restricted: boolean;
  claims: FrameClaim[];
}

export interface ClassroomMessage extends BoardMessage {
  classroom: Classroom | null;
}

export interface PrivateModeMessage extends BoardMessage {
  privateMode: PrivateMode | null;
}

export interface ViewportMessage extends SharedView, BoardMessage {
  socketId: string;
  source: string;
}

export interface ThreadRemoval {
  id: string;
}

// nobody sees anyone else's votes until the round ends; then `results` has the votes each element got
export interface Voting {
  open: boolean;
  votes: number;
  mine: string[];
  voters: number;
  results: Record<string, number> | null;
}

export interface VotingMessage extends BoardMessage {
  voting: Voting | null;
}

export interface SuggestionsMessage extends BoardMessage {
  suggestions: Suggestion[];
}

// why: a member accepted or rejected them, their author withdrew them, or what they were about is gone (removed, accepted another way, or too old)
export interface SuggestionRemovalMessage extends BoardMessage {
  ids: string[];
  outcome: SuggestionOutcome | "withdrawn" | "gone";
}

export interface ClientToServerEvents {
  "board:join": (payload: JoinPayload, ack: (reply: JoinReply) => void) => void;
  "board:leave": () => void;
  "board:op": (payload: OpPayload, ack: (reply: OpReply) => void) => void;
  "board:image": (payload: ImagePayload, ack: (reply: ImageReply) => void) => void;
  "board:replay": (payload: ReplayPayload, ack: (reply: ReplayReply) => void) => void;
  cursor: (payload: CursorPayload) => void;
  viewport: (payload: ViewportPayload) => void;
  "viewport:request": (payload: ViewportRequestPayload) => void;
  present: (payload: PresentPayload) => void;
  countdown: (payload: CountdownPayload) => void;
  private: (payload: PrivatePayload) => void;
  classroom: (payload: ClassroomPayload, ack: (reply: { ok: boolean }) => void) => void;
  "guest:rename": (payload: RenamePayload) => void;
  vote: (payload: VotePayload) => void;
  "suggestion:put": (payload: SuggestionPutPayload, ack: (reply: SuggestionPutReply) => void) => void;
  "suggestion:withdraw": (payload: SuggestionWithdrawPayload, ack: (reply: SuggestionReply) => void) => void;
  "suggestion:resolve": (payload: SuggestionResolvePayload, ack: (reply: SuggestionReply) => void) => void;
}

export interface ServerToClientEvents {
  "board:op": (message: OpMessage) => void;
  "board:meta": (meta: BoardMeta) => void;
  "board:reset": (message: ResetMessage) => void;
  "board:revoked": (message: RevokedMessage) => void;
  "board:role": (message: RoleMessage) => void;
  "board:deleted": (message: BoardMessage) => void;
  // the board's id comes second, so older browsers, which expect just the list, still read it
  presence: (people: Peer[], board: BoardMessage) => void;
  cursor: (message: CursorMessage) => void;
  viewport: (message: ViewportMessage) => void;
  "viewport:request": (message: BoardMessage) => void;
  countdown: (message: CountdownMessage) => void;
  private: (message: PrivateModeMessage) => void;
  classroom: (message: ClassroomMessage) => void;
  notification: (notification: NotificationItem) => void;
  "thread:upsert": (thread: Thread) => void;
  "thread:delete": (thread: ThreadRemoval) => void;
  "suggestion:upsert": (message: SuggestionsMessage) => void;
  "suggestion:delete": (message: SuggestionRemovalMessage) => void;
  voting: (message: VotingMessage) => void;
}
