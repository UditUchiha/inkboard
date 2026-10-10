import type { Element as BoardElement } from "@inkboard/shared/types";
import { API_URL } from "../config";

/** What the server shows of anyone (see serializePerson on the server). */
export interface Person {
  id: string;
  name: string;
  color?: string | null;
  avatarUrl?: string | null;
}

/** What other people may see about someone, with their email address (see toPublic on the server). */
export interface PublicUser extends Person {
  email: string;
}

/** The signed-in person's own account (see toAccount on the server). */
export interface AccountUser extends PublicUser {
  emailVerified: boolean;
  hasPassword: boolean;
  /** Which sign-in providers the account is linked to. */
  providers: Record<string, boolean>;
}

/** What logging in, registering and finishing a password reset or an OAuth sign-in return. */
export interface Session {
  token: string;
  user: AccountUser;
}

export type LoginInput = { email: string; password: string };
export type RegisterInput = LoginInput & { name: string };

/** Who can open a board by its link. */
export type LinkAccess = "restricted" | "view" | "edit";

/** What a board's creation can start from: a title, or a title with what to draw on it. */
export type CreateBoardInput = { title?: string; elements?: BoardElement[]; templateId?: string };

export type NotificationType = "mention" | "reply" | "invite";

/** A mention, reply or invite, as the server sends it (see serializeNotification there). */
export interface NotificationItem {
  id: string;
  type: NotificationType;
  read: boolean;
  createdAt: string;
  excerpt: string | null;
  thread: string | null;
  actor: Person;
  board: { id: string; title: string };
}

/** One page of notifications, newest first. */
export interface NotificationPage {
  notifications: NotificationItem[];
  more: boolean;
  /** Where the next page starts (pass it to listNotifications), or null on the last page. */
  next: string | null;
  unread: number;
}

export class ApiError extends Error {
  declare status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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

// `T` is what the caller expects the server to answer with: it isn't checked, only the callers know the endpoint.
async function request<T = unknown>(path: string, { method = "GET", body }: RequestOptions = {}): Promise<T> {
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
  me: () => request<{ user: AccountUser }>("/auth/me"),
  updateProfile: (input: { name?: string; color?: string | null }) =>
    request<{ user: AccountUser }>("/auth/me", { method: "PATCH", body: input }),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<Session>("/auth/password", { method: "POST", body: input }),
  verifyEmail: (token: string) => request("/auth/verify-email", { method: "POST", body: { token } }),
  resendVerification: () => request("/auth/verify-email/resend", { method: "POST" }),
  forgotPassword: (email: string) => request("/auth/forgot-password", { method: "POST", body: { email } }),
  resetPassword: (input: { token: string; password: string }) =>
    request<Session>("/auth/reset-password", { method: "POST", body: input }),
  listProviders: () => request("/auth/providers"),
  // Returns { url, bind }: the URL starts connecting the provider to the signed-in account, and `bind`
  // is kept in the tab to hand back with what comes back (confirmProviderLink).
  linkProvider: (provider: string) =>
    request<{ url: string; bind: string }>(`/auth/oauth/${provider}/link`, { method: "POST" }),
  // `input` is { connect, bind }: the note the provider's sign-in came back with, and the tab's `bind`.
  confirmProviderLink: (provider: string, input: { connect: string; bind: string }) =>
    request(`/auth/oauth/${provider}/link/confirm`, { method: "POST", body: input }),
  // `input` is { code, bind }: the sign-in code from the OAuth redirect, and the `bind` this tab kept when it
  // started signing in. Returns { token, user }.
  exchangeOAuthCode: (input: { code: string; bind: string }) =>
    request<Session>("/auth/oauth/exchange", { method: "POST", body: input }),
  logoutEverywhere: () => request("/auth/logout-everywhere", { method: "POST" }),
  disconnectProvider: (provider: string) =>
    request<{ user: AccountUser }>(`/auth/oauth/${provider}`, { method: "DELETE" }),

  listBoards: () => request("/boards"),
  // Previews (a light copy of each drawing, to draw cards from) of up to 24 boards, as { previews: { [id]: elements } }.
  boardPreviews: (ids: string[]) => request(`/boards/previews?ids=${ids.join(",")}`),
  // `input` is a title, or { title, elements } / { title, templateId }.
  createBoard: (input: string | CreateBoardInput = {}) =>
    request("/boards", { method: "POST", body: typeof input === "string" ? { title: input } : input }),
  renameBoard: (id: string, title: string) => request(`/boards/${id}`, { method: "PATCH", body: { title } }),
  // Moves the board to the owner's trash (everyone loses access until it's restored).
  deleteBoard: (id: string) => request(`/boards/${id}`, { method: "DELETE" }),
  starBoard: (id: string, starred: boolean) => request(`/boards/${id}/star`, { method: "PUT", body: { starred } }),
  listTrash: () => request("/boards/trash"),
  restoreBoard: (id: string) => request(`/boards/${id}/restore`, { method: "POST" }),
  purgeBoard: (id: string) => request(`/boards/${id}/permanent`, { method: "DELETE" }),
  emptyTrash: () => request("/boards/trash", { method: "DELETE" }),
  // Archive or unarchive boards for this person only.
  archiveBoards: (ids: string[], archived: boolean) =>
    request("/boards/archive", { method: "PATCH", body: { ids, archived } }),
  // Drop a board from this person's dashboard (used for boards they only opened from a link).
  forgetBoard: (id: string) => request(`/boards/${id}/state`, { method: "DELETE" }),
  setLinkAccess: (id: string, linkAccess: LinkAccess) =>
    request(`/boards/${id}/link-access`, { method: "PATCH", body: { linkAccess } }),
  inviteCollaborator: (id: string, email: string) =>
    request(`/boards/${id}/collaborators`, { method: "POST", body: { email } }),
  removeCollaborator: (id: string, userId: string) =>
    request(`/boards/${id}/collaborators/${userId}`, { method: "DELETE" }),

  listVersions: (id: string) => request(`/boards/${id}/versions`),
  getVersion: (id: string, versionId: string) => request(`/boards/${id}/versions/${versionId}`),
  saveVersion: (id: string, label: string) => request(`/boards/${id}/versions`, { method: "POST", body: { label } }),
  restoreVersion: (id: string, versionId: string) =>
    request(`/boards/${id}/versions/${versionId}/restore`, { method: "POST" }),
  deleteVersion: (id: string, versionId: string) =>
    request(`/boards/${id}/versions/${versionId}`, { method: "DELETE" }),

  listTemplates: () => request("/templates"),
  saveTemplate: (boardId: string, title: string) => request("/templates", { method: "POST", body: { boardId, title } }),
  deleteTemplate: (id: string) => request(`/templates/${id}`, { method: "DELETE" }),

  listThreads: (id: string) => request(`/boards/${id}/threads`),
  createThread: (id: string, input: Record<string, unknown>) =>
    request(`/boards/${id}/threads`, { method: "POST", body: input }),
  replyToThread: (id: string, threadId: string, input: Record<string, unknown>) =>
    request(`/boards/${id}/threads/${threadId}/messages`, { method: "POST", body: input }),
  updateThread: (id: string, threadId: string, changes: Record<string, unknown>) =>
    request(`/boards/${id}/threads/${threadId}`, { method: "PATCH", body: changes }),
  deleteThread: (id: string, threadId: string) => request(`/boards/${id}/threads/${threadId}`, { method: "DELETE" }),

  // The newest page, or with `before` (the id of the oldest one shown) the page after it.
  listNotifications: (before?: string) =>
    request<NotificationPage>(`/notifications${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  markNotificationsRead: (ids?: string[]) =>
    request("/notifications/read", { method: "POST", body: ids ? { ids } : {} }),
};
