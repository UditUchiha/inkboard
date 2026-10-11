// The shapes the HTTP API answers with. The server's serializers and controllers declare that they produce them
// and the browser's API module declares that each endpoint returns them, so a field renamed on one side stops
// the other from type checking. This file holds types only, so it adds nothing at run time.
//
// The shapes are written the way the server builds them, with a `Date` where it has one. JSON turns a Date into
// an ISO string on the way, so what the browser receives is `Wire<Shape>` (see Wire below).

import type { Element } from "./types.ts";

/** What a value becomes after JSON: a Date turns into its ISO string, everything else keeps its shape. */
export type Wire<T> = T extends Date ? string : T extends object ? { [Key in keyof T]: Wire<T[Key]> } : T;

// People and accounts

/** What the server shows of anyone (see serializePerson on the server). */
export interface Person {
  id: string;
  name: string;
  color: string | null;
  avatarUrl: string | null;
}

/** What other people may see about someone, with their email address (see toPublic on the server). */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  color?: string | null;
  avatarUrl?: string | null;
}

/** A sign-in provider an account can be linked to. */
export type OAuthProvider = "google" | "github";

/** The signed-in person's own account (see toAccount on the server). */
export interface AccountUser extends PublicUser {
  emailVerified: boolean;
  hasPassword: boolean;
  /** Which sign-in providers the account is linked to. */
  providers: Record<string, boolean>;
}

/** What logging in, registering and finishing a password reset or an OAuth sign-in answer with. */
export interface Session {
  token: string;
  user: AccountUser;
}

/** `{ user }`: the account as it is now (reading it, changing it, and connecting or disconnecting a provider). */
export interface UserReply {
  user: AccountUser;
}

/** What verifying an email address answers with: the address that was verified, and the account as it is now. */
export interface VerifiedEmailReply {
  email: string;
  user: AccountUser;
}

/** What sending an email (a new verification link, a password reset link) answers with. */
export interface SentReply {
  sent: true;
}

/** A sign-in provider the server has set up. */
export interface AuthProviderInfo {
  id: OAuthProvider;
  label: string;
}

/** How people can sign in: the providers that are set up, and whether email verification and password reset are on. */
export interface ProvidersReply {
  providers: AuthProviderInfo[];
  email: boolean;
}

/** What starting to connect a provider answers with: the URL that starts it, and the `bind` the tab keeps for confirming it. */
export interface LinkTicketReply {
  url: string;
  bind: string;
}

// Boards

/**
 * What a person can do on a board (see roleOf on the server). A suggester's changes don't change the board:
 * they become suggestions, which a member accepts or rejects (see docs/suggest-mode.md).
 */
export type Role = "owner" | "editor" | "contributor" | "suggester" | "viewer";

/** Who can open a board by its link, and what they can do there: look, suggest changes, or edit. */
export type LinkAccess = "restricted" | "view" | "suggest" | "edit";

/** Someone a board lists as a collaborator, with their email address. Only a board's members see these. */
export type Member = Person & { email: string };

/** A board's owner: with an email address only for a member of the board (anyone else gets the person without it). */
export type Owner = Person & { email?: string };

/** A board's details: who made it, who is invited to it and how the link opens it. */
export interface BoardMeta {
  id: string;
  title: string;
  owner: Owner;
  /** Empty for anyone who isn't a member. */
  collaborators: Member[];
  linkAccess: LinkAccess;
  createdAt: Date;
  updatedAt: Date;
}

/** A board as one person sees it, without its drawing. */
export interface BoardSummary extends BoardMeta {
  /** What the person asking can do on the board. */
  role: Role;
  starred: boolean;
}

/** What one person has done with a board: when they last opened it, and whether they archived it. */
export interface BoardFiling {
  lastOpenedAt: Date | null;
  archived: boolean;
}

/** A board with its drawing. Its filing comes only with the dashboard's list (see ListedBoard). */
export interface BoardDetails extends BoardSummary {
  elements: Element[];
}

/** A board as the dashboard lists it. */
export type ListedBoard = BoardSummary & BoardFiling;

/** A board in the owner's trash: when it was deleted and when it will be erased for good. It has no filing. */
export type TrashedBoard = BoardSummary & { deletedAt: Date; purgeAt: Date };

/** An element as a dashboard card or a template's preview draws it: the same shape, with less data. */
export type PreviewElement = Element;

/** `{ board }` with the board's drawing (opening, creating and restoring a board). */
export interface BoardReply {
  board: BoardDetails;
}

/** `{ board }` with its details only (renaming, sharing and inviting). */
export interface BoardMetaReply {
  board: BoardMeta;
}

/** The boards the person can open. */
export interface BoardListReply {
  boards: ListedBoard[];
}

/** The boards in the person's trash. */
export interface TrashListReply {
  boards: TrashedBoard[];
}

/** Previews of the boards that were asked for, by board id. */
export interface PreviewsReply {
  previews: Record<string, PreviewElement[]>;
}

/** What starring or unstarring a board answers with. */
export interface StarReply {
  starred: boolean;
}

/** What archiving or unarchiving boards answers with: the ids that were allowed, and whether they are archived now. */
export interface ArchiveReply {
  ids: string[];
  archived: boolean;
}

// Comments

/** One comment in a thread. `mentions` are the people named in it. */
export interface ThreadMessage {
  id: string;
  author: Person;
  body: string;
  mentions: Person[];
  createdAt: Date;
}

/** A comment thread, pinned at (x, y) on the board. */
export interface Thread {
  id: string;
  x: number;
  y: number;
  resolved: boolean;
  author: Person;
  createdAt: Date;
  messages: ThreadMessage[];
}

/** A board's comment threads, oldest first. */
export interface ThreadListReply {
  threads: Thread[];
}

/** `{ thread }`: the thread as it is now (starting, replying to and changing one). */
export interface ThreadReply {
  thread: Thread;
}

// Version history

/** How a version came about: saved by itself, named by someone, or saved just before a restore. */
export type VersionKind = "auto" | "named" | "restore";

/** A saved version of a board as the history lists it, without its drawing. */
export interface VersionSummary {
  id: string;
  kind: VersionKind;
  /** The name someone gave it; automatic versions have none. */
  label: string | null;
  /** Who saved it; automatic versions have no author. */
  author: Person | null;
  elementCount: number;
  createdAt: Date;
}

/** A saved version with its drawing. */
export interface FullVersion extends VersionSummary {
  elements: Element[];
}

/** A board's saved versions, newest first. */
export interface VersionListReply {
  versions: VersionSummary[];
}

/** `{ version }` without its drawing (saving a version). */
export interface VersionReply {
  version: VersionSummary;
}

/** `{ version }` with its drawing (opening a version). */
export interface FullVersionReply {
  version: FullVersion;
}

/** What restoring a version answers with: the board's drawing as it is now. */
export interface RestoredVersionReply {
  elements: Element[];
}

// Templates

/** One of the person's saved templates, with a light preview rather than the drawing. */
export interface TemplateSummary {
  id: string;
  title: string;
  elementCount: number;
  preview: PreviewElement[];
  createdAt: Date;
}

/** The person's saved templates, newest first. */
export interface TemplateListReply {
  templates: TemplateSummary[];
}

/** `{ template }`: the template that was just saved. */
export interface TemplateReply {
  template: TemplateSummary;
}

// Notifications

/** Why someone was notified. */
export type NotificationType = "mention" | "reply" | "invite";

/** A mention, reply or invite (see serializeNotification on the server). */
export interface NotificationItem {
  id: string;
  type: NotificationType;
  read: boolean;
  createdAt: Date;
  excerpt: string | null;
  thread: string | null;
  actor: Person;
  board: { id: string; title: string };
}

/** One page of notifications, newest first. */
export interface NotificationPage {
  notifications: NotificationItem[];
  more: boolean;
  /** Where the next page starts (pass it as `before`), or null on the last page. */
  next: string | null;
  unread: number;
}
