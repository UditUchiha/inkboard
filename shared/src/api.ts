// The shapes the HTTP API answers with, checked on both sides so a renamed field stops the other from type checking.
// Types only. They are written as the server builds them, with a `Date` where it has one; JSON turns that into an ISO
// string, so the browser receives `Wire<Shape>`.

import type { Element } from "./types.ts";

export type Wire<T> = T extends Date ? string : T extends object ? { [Key in keyof T]: Wire<T[Key]> } : T;

export interface Person {
  id: string;
  name: string;
  color: string | null;
  avatarUrl: string | null;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  color?: string | null;
  avatarUrl?: string | null;
}

export type OAuthProvider = "google" | "github";

export interface AccountUser extends PublicUser {
  emailVerified: boolean;
  hasPassword: boolean;
  providers: Record<string, boolean>;
}

export interface Session {
  token: string;
  user: AccountUser;
}

export interface UserReply {
  user: AccountUser;
}

export interface VerifiedEmailReply {
  email: string;
  user: AccountUser;
}

export interface SentReply {
  sent: true;
}

export interface AuthProviderInfo {
  id: OAuthProvider;
  label: string;
}

export interface ProvidersReply {
  providers: AuthProviderInfo[];
  email: boolean;
}

/** What starting to connect a provider answers with: the URL that starts it, and the `bind` the tab keeps for confirming it. */
export interface LinkTicketReply {
  url: string;
  bind: string;
}

// a suggester's changes become suggestions, which a member accepts or rejects (see docs/suggest-mode.md)
export type Role = "owner" | "editor" | "contributor" | "suggester" | "viewer";

export type LinkAccess = "restricted" | "view" | "suggest" | "edit";

/** Someone a board lists as a collaborator, with their email address. Only a board's members see these. */
export type Member = Person & { email: string };

/** A board's owner: with an email address only for a member of the board (anyone else gets the person without it). */
export type Owner = Person & { email?: string };

export interface BoardMeta {
  id: string;
  title: string;
  owner: Owner;
  /** Empty for anyone who isn't a member. */
  collaborators: Member[];
  linkAccess: LinkAccess;
  /** Whether the link asks for a password (people invited to the board never need it). */
  linkPassword: boolean;
  linkExpiresAt: Date | null;
  /** Whether people who open the board by its link can watch its replay (members always can). */
  linkReplay: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type LinkLock = "password" | "expired";

export interface LinkPassReply {
  pass: string;
}

export interface BoardSummary extends BoardMeta {
  role: Role;
  starred: boolean;
}

export interface BoardFiling {
  lastOpenedAt: Date | null;
  archived: boolean;
}

export interface BoardDetails extends BoardSummary {
  elements: Element[];
}

export type ListedBoard = BoardSummary & BoardFiling;

export type TrashedBoard = BoardSummary & { deletedAt: Date; purgeAt: Date };

export type PreviewElement = Element;

export interface BoardReply {
  board: BoardDetails;
}

export interface BoardMetaReply {
  board: BoardMeta;
}

export interface BoardListReply {
  boards: ListedBoard[];
}

// bytes used by the boards someone owns (trashed included) out of what they may hold; `unverified` marks the smaller
// limit of an unconfirmed address
export interface ImageUsage {
  used: number;
  limit: number;
  boardLimit: number;
  unverified: boolean;
  boards: { id: string; title: string; bytes: number; trashed: boolean }[];
}

export interface TrashListReply {
  boards: TrashedBoard[];
}

export interface PreviewsReply {
  previews: Record<string, PreviewElement[]>;
}

export interface StarReply {
  starred: boolean;
}

export interface ArchiveReply {
  ids: string[];
  archived: boolean;
}

export interface Reaction {
  emoji: string;
  people: Person[];
}

export interface ThreadMessage {
  id: string;
  author: Person;
  body: string;
  mentions: Person[];
  reactions: Reaction[];
  createdAt: Date;
}

export interface Thread {
  id: string;
  x: number;
  y: number;
  resolved: boolean;
  author: Person;
  createdAt: Date;
  messages: ThreadMessage[];
}

export interface ThreadListReply {
  threads: Thread[];
}

export interface ThreadReply {
  thread: Thread;
}

export type VersionKind = "auto" | "named" | "restore";

export interface VersionSummary {
  id: string;
  kind: VersionKind;
  label: string | null;
  author: Person | null;
  elementCount: number;
  createdAt: Date;
}

export interface FullVersion extends VersionSummary {
  elements: Element[];
}

export interface VersionListReply {
  versions: VersionSummary[];
}

export interface VersionReply {
  version: VersionSummary;
}

export interface FullVersionReply {
  version: FullVersion;
}

export interface RestoredVersionReply {
  elements: Element[];
}

export interface TemplateSummary {
  id: string;
  title: string;
  elementCount: number;
  preview: PreviewElement[];
  createdAt: Date;
}

export interface TemplateListReply {
  templates: TemplateSummary[];
}

export interface TemplateReply {
  template: TemplateSummary;
}

export type NotificationType =
  "mention" | "reply" | "invite" | "suggestion" | "trashed" | "access" | "visitors" | "removals";

// an access request's excerpt is the asker's email address (see serializeNotification on the server)
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

export interface NotificationPage {
  notifications: NotificationItem[];
  more: boolean;
  next: string | null;
  unread: number;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  start: string;
  /** "read" can only read boards; "write" can change them too. */
  scope: "read" | "write";
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface ApiTokenListReply {
  tokens: ApiTokenInfo[];
}

export interface ApiTokenCreatedReply {
  token: string;
  info: ApiTokenInfo;
}
