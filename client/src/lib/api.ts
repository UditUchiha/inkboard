import type * as shared from "@inkboard/shared/api";
import type { Wire } from "@inkboard/shared/api";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { API_URL } from "../config";

// The shapes the server answers with are declared once, in @inkboard/shared/api. These are what arrives here: JSON
// has turned their Dates into ISO strings (see Wire), so the rest of the app imports them by these names.

/**
 * Someone to show: what the server sends of anyone (see serializePerson there, which always sends a color and a
 * picture, or null), except that these two may be missing, as they are on an account or a guest.
 */
export type Person = Pick<Wire<shared.Person>, "id" | "name"> & Partial<Wire<shared.Person>>;

/** The signed-in person's own account (see toAccount on the server). */
export type AccountUser = Wire<shared.AccountUser>;

/** What logging in, registering and finishing a password reset or an OAuth sign-in return. */
export type Session = Wire<shared.Session>;

/** A sign-in provider the server has set up. */
export type AuthProviderInfo = Wire<shared.AuthProviderInfo>;

/** What a person can do on a board. */
export type Role = shared.Role;

/** Who can open a board by its link. */
export type LinkAccess = shared.LinkAccess;

/** Someone a board lists as a collaborator, with their email address. */
export type Member = Wire<shared.Member>;

/** A board's details: who made it, who is invited to it and how the link opens it. */
export type BoardMeta = Wire<shared.BoardMeta>;

/** A board with its drawing, as opening or creating one answers. */
export type BoardDetails = Wire<shared.BoardDetails>;

/** A board as the dashboard lists it. */
export type ListedBoard = Wire<shared.ListedBoard>;

/** A board in the owner's trash. */
export type TrashedBoard = Wire<shared.TrashedBoard>;

/** The part of a board's listing that is one person's own: when they last opened it, and whether they archived it. */
export type BoardFiling = Wire<shared.BoardFiling>;

/** One comment in a thread. */
export type ThreadMessage = Wire<shared.ThreadMessage>;

/** A comment thread pinned to a point on the board. */
export type Thread = Wire<shared.Thread>;

/** How a version came about: saved by itself, named by someone, or saved just before a restore. */
export type VersionKind = shared.VersionKind;

/** A saved version of a board as the history lists it, without its drawing. */
export type Version = Wire<shared.VersionSummary>;

/** One of the person's saved templates, with a light preview rather than the drawing. */
export type TemplateSummary = Wire<shared.TemplateSummary>;

/** Why someone was notified. */
export type NotificationType = shared.NotificationType;

/** A mention, reply or invite, as the server sends it (see serializeNotification there). */
export type NotificationItem = Wire<shared.NotificationItem>;

/** One page of notifications, newest first. */
export type NotificationPage = Wire<shared.NotificationPage>;

export type LoginInput = { email: string; password: string };
export type RegisterInput = LoginInput & { name: string };

/** What a board's creation can start from: a title, or a title with what to draw on it. */
export type CreateBoardInput = { title?: string; elements?: BoardElement[]; templateId?: string };

export class ApiError extends Error {
  declare status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * What to tell the person about something a request (or the code around it) threw. A request only throws an
 * ApiError, whose message is written for people; anything else that isn't even an Error gets a general one.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

let authToken: string | null = null;
let onUnauthorized: () => void = () => {};

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

type RequestOptions = { method?: string; body?: unknown };

// `T` is what the endpoint answers with (void for a 204, which has no body). It isn't checked here: each method of
// `api` says it, and what it says is a shape the server declares it sends (see @inkboard/shared/api).
async function request<T>(path: string, { method = "GET", body }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // The login this request is made with: if it's refused, only that login is over, not one made since.
  const sentWith = authToken;
  if (sentWith) headers.Authorization = `Bearer ${sentWith}`;

  let response: Response;
  try {
    response = await fetch(`${API_URL}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }

  const data: { error?: string } | null = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    // A late answer to a request made before the person logged in again must not log the new login out
    // (another tab may have changed it, or a password change just replaced it).
    if (response.status === 401 && sentWith && sentWith === authToken) onUnauthorized();
    throw new ApiError(response.status, data?.error ?? "Something went wrong. Try again.");
  }
  // The body is whatever the endpoint sends; nothing here can check it against `T`.
  return data as T;
}

export const api = {
  register: (input: RegisterInput) => request<Session>("/auth/register", { method: "POST", body: input }),
  login: (input: LoginInput) => request<Session>("/auth/login", { method: "POST", body: input }),
  me: () => request<Wire<shared.UserReply>>("/auth/me"),
  updateProfile: (input: { name?: string; color?: string | null }) =>
    request<Wire<shared.UserReply>>("/auth/me", { method: "PATCH", body: input }),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<Session>("/auth/password", { method: "POST", body: input }),
  // Returns the address that was verified and the account as it is now.
  verifyEmail: (token: string) =>
    request<Wire<shared.VerifiedEmailReply>>("/auth/verify-email", { method: "POST", body: { token } }),
  resendVerification: () => request<Wire<shared.SentReply>>("/auth/verify-email/resend", { method: "POST" }),
  forgotPassword: (email: string) =>
    request<Wire<shared.SentReply>>("/auth/forgot-password", { method: "POST", body: { email } }),
  resetPassword: (input: { token: string; password: string }) =>
    request<Session>("/auth/reset-password", { method: "POST", body: input }),
  listProviders: () => request<Wire<shared.ProvidersReply>>("/auth/providers"),
  // Returns { url, bind }: the URL starts connecting the provider to the signed-in account, and `bind`
  // is kept in the tab to hand back with what comes back (confirmProviderLink).
  linkProvider: (provider: string) =>
    request<Wire<shared.LinkTicketReply>>(`/auth/oauth/${provider}/link`, { method: "POST" }),
  // `input` is { connect, bind }: the note the provider's sign-in came back with, and the tab's `bind`. Returns
  // the account, with the provider now connected.
  confirmProviderLink: (provider: string, input: { connect: string; bind: string }) =>
    request<Wire<shared.UserReply>>(`/auth/oauth/${provider}/link/confirm`, { method: "POST", body: input }),
  // `input` is { code, bind }: the sign-in code from the OAuth redirect, and the `bind` this tab kept when it
  // started signing in. Returns { token, user }.
  exchangeOAuthCode: (input: { code: string; bind: string }) =>
    request<Session>("/auth/oauth/exchange", { method: "POST", body: input }),
  logoutEverywhere: () => request<void>("/auth/logout-everywhere", { method: "POST" }),
  disconnectProvider: (provider: string) =>
    request<Wire<shared.UserReply>>(`/auth/oauth/${provider}`, { method: "DELETE" }),

  listBoards: () => request<Wire<shared.BoardListReply>>("/boards"),
  // Previews (a light copy of each drawing, to draw cards from) of up to 24 boards, as { previews: { [id]: elements } }.
  boardPreviews: (ids: string[]) => request<Wire<shared.PreviewsReply>>(`/boards/previews?ids=${ids.join(",")}`),
  // `input` is a title, or { title, elements } / { title, templateId }.
  createBoard: (input: string | CreateBoardInput = {}) =>
    request<Wire<shared.BoardReply>>("/boards", {
      method: "POST",
      body: typeof input === "string" ? { title: input } : input,
    }),
  renameBoard: (id: string, title: string) =>
    request<Wire<shared.BoardMetaReply>>(`/boards/${id}`, { method: "PATCH", body: { title } }),
  // Moves the board to the owner's trash (everyone loses access until it's restored).
  deleteBoard: (id: string) => request<void>(`/boards/${id}`, { method: "DELETE" }),
  starBoard: (id: string, starred: boolean) =>
    request<Wire<shared.StarReply>>(`/boards/${id}/star`, { method: "PUT", body: { starred } }),
  listTrash: () => request<Wire<shared.TrashListReply>>("/boards/trash"),
  restoreBoard: (id: string) => request<Wire<shared.BoardReply>>(`/boards/${id}/restore`, { method: "POST" }),
  purgeBoard: (id: string) => request<void>(`/boards/${id}/permanent`, { method: "DELETE" }),
  emptyTrash: () => request<void>("/boards/trash", { method: "DELETE" }),
  // Archive or unarchive boards for this person only.
  archiveBoards: (ids: string[], archived: boolean) =>
    request<Wire<shared.ArchiveReply>>("/boards/archive", { method: "PATCH", body: { ids, archived } }),
  // Drop a board from this person's dashboard (used for boards they only opened from a link).
  forgetBoard: (id: string) => request<void>(`/boards/${id}/state`, { method: "DELETE" }),
  setLinkAccess: (id: string, linkAccess: LinkAccess) =>
    request<Wire<shared.BoardMetaReply>>(`/boards/${id}/link-access`, { method: "PATCH", body: { linkAccess } }),
  inviteCollaborator: (id: string, email: string) =>
    request<Wire<shared.BoardMetaReply>>(`/boards/${id}/collaborators`, { method: "POST", body: { email } }),
  removeCollaborator: (id: string, userId: string) =>
    request<Wire<shared.BoardMetaReply>>(`/boards/${id}/collaborators/${userId}`, { method: "DELETE" }),

  listVersions: (id: string) => request<Wire<shared.VersionListReply>>(`/boards/${id}/versions`),
  getVersion: (id: string, versionId: string) =>
    request<Wire<shared.FullVersionReply>>(`/boards/${id}/versions/${versionId}`),
  saveVersion: (id: string, label: string) =>
    request<Wire<shared.VersionReply>>(`/boards/${id}/versions`, { method: "POST", body: { label } }),
  restoreVersion: (id: string, versionId: string) =>
    request<Wire<shared.RestoredVersionReply>>(`/boards/${id}/versions/${versionId}/restore`, { method: "POST" }),
  deleteVersion: (id: string, versionId: string) =>
    request<void>(`/boards/${id}/versions/${versionId}`, { method: "DELETE" }),

  listTemplates: () => request<Wire<shared.TemplateListReply>>("/templates"),
  saveTemplate: (boardId: string, title: string) =>
    request<Wire<shared.TemplateReply>>("/templates", { method: "POST", body: { boardId, title } }),
  deleteTemplate: (id: string) => request<void>(`/templates/${id}`, { method: "DELETE" }),

  listThreads: (id: string) => request<Wire<shared.ThreadListReply>>(`/boards/${id}/threads`),
  createThread: (id: string, input: Record<string, unknown>) =>
    request<Wire<shared.ThreadReply>>(`/boards/${id}/threads`, { method: "POST", body: input }),
  replyToThread: (id: string, threadId: string, input: Record<string, unknown>) =>
    request<Wire<shared.ThreadReply>>(`/boards/${id}/threads/${threadId}/messages`, { method: "POST", body: input }),
  updateThread: (id: string, threadId: string, changes: Record<string, unknown>) =>
    request<Wire<shared.ThreadReply>>(`/boards/${id}/threads/${threadId}`, { method: "PATCH", body: changes }),
  deleteThread: (id: string, threadId: string) =>
    request<void>(`/boards/${id}/threads/${threadId}`, { method: "DELETE" }),

  // The newest page, or with `before` (the id of the oldest one shown) the page after it.
  listNotifications: (before?: string) =>
    request<NotificationPage>(`/notifications${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  markNotificationsRead: (ids?: string[]) =>
    request<void>("/notifications/read", { method: "POST", body: ids ? { ids } : {} }),
};
