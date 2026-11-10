import type * as shared from "@inkboard/shared/api";
import type { Wire } from "@inkboard/shared/api";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { API_URL } from "../config";

// Wire types: the server's @inkboard/shared/api shapes after JSON turned their Dates into ISO strings.

// Name and picture may be missing, as on an account or a guest.
export type Person = Pick<Wire<shared.Person>, "id" | "name"> & Partial<Wire<shared.Person>>;

export type AccountUser = Wire<shared.AccountUser>;

export type Session = Wire<shared.Session>;

export type AuthProviderInfo = Wire<shared.AuthProviderInfo>;

export type Role = shared.Role;

export type LinkAccess = shared.LinkAccess;

export type Member = Wire<shared.Member>;

export type BoardMeta = Wire<shared.BoardMeta>;

export type BoardDetails = Wire<shared.BoardDetails>;

export type ImageUsage = shared.ImageUsage;

export type ApiTokenInfo = Wire<shared.ApiTokenInfo>;

export type ListedBoard = Wire<shared.ListedBoard>;

export type TrashedBoard = Wire<shared.TrashedBoard>;

export type BoardFiling = Wire<shared.BoardFiling>;

export type ThreadMessage = Wire<shared.ThreadMessage>;

export type Thread = Wire<shared.Thread>;

export type VersionKind = shared.VersionKind;

export type Version = Wire<shared.VersionSummary>;

export type TemplateSummary = Wire<shared.TemplateSummary>;

export type NotificationType = shared.NotificationType;

export type NotificationItem = Wire<shared.NotificationItem>;

export type NotificationPage = Wire<shared.NotificationPage>;

export type LoginInput = { email: string; password: string };
export type RegisterInput = LoginInput & { name: string };

export type CreateBoardInput = { title?: string; elements?: BoardElement[]; templateId?: string };

export class ApiError extends Error {
  declare status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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

// `T` isn't checked here: each api method states a shape the server declares it sends (@inkboard/shared/api).
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
    // A late answer to a request made before a re-login must not log the new login out.
    if (response.status === 401 && sentWith && sentWith === authToken) onUnauthorized();
    throw new ApiError(response.status, data?.error ?? "Something went wrong. Try again.");
  }
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
  verifyEmail: (token: string) =>
    request<Wire<shared.VerifiedEmailReply>>("/auth/verify-email", { method: "POST", body: { token } }),
  resendVerification: () => request<Wire<shared.SentReply>>("/auth/verify-email/resend", { method: "POST" }),
  forgotPassword: (email: string) =>
    request<Wire<shared.SentReply>>("/auth/forgot-password", { method: "POST", body: { email } }),
  resetPassword: (input: { token: string; password: string }) =>
    request<Session>("/auth/reset-password", { method: "POST", body: input }),
  listProviders: () => request<Wire<shared.ProvidersReply>>("/auth/providers"),
  // `bind` is kept in the tab to hand back with confirmProviderLink.
  linkProvider: (provider: string) =>
    request<Wire<shared.LinkTicketReply>>(`/auth/oauth/${provider}/link`, { method: "POST" }),
  confirmProviderLink: (provider: string, input: { connect: string; bind: string }) =>
    request<Wire<shared.UserReply>>(`/auth/oauth/${provider}/link/confirm`, { method: "POST", body: input }),
  exchangeOAuthCode: (input: { code: string; bind: string }) =>
    request<Session>("/auth/oauth/exchange", { method: "POST", body: input }),
  logoutEverywhere: () => request<void>("/auth/logout-everywhere", { method: "POST" }),
  disconnectProvider: (provider: string) =>
    request<Wire<shared.UserReply>>(`/auth/oauth/${provider}`, { method: "DELETE" }),

  listBoards: () => request<Wire<shared.BoardListReply>>("/boards"),
  // Previews (a light copy of each drawing, to draw cards from) of up to 24 boards, as { previews: { [id]: elements }
  // }.
  boardPreviews: (ids: string[]) => request<Wire<shared.PreviewsReply>>(`/boards/previews?ids=${ids.join(",")}`),
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
  imageUsage: () => request<shared.ImageUsage>("/boards/image-usage"),
  // Tokens for the public API and the MCP server (see docs/api.md). A new token is in the reply only once.
  listApiTokens: () => request<Wire<shared.ApiTokenListReply>>("/tokens"),
  createApiToken: (name: string, scope: ApiTokenInfo["scope"]) =>
    request<Wire<shared.ApiTokenCreatedReply>>("/tokens", { method: "POST", body: { name, scope } }),
  deleteApiToken: (id: string) => request<void>(`/tokens/${id}`, { method: "DELETE" }),
  copyBoard: (id: string) => request<Wire<shared.BoardReply>>(`/boards/${id}/copy`, { method: "POST" }),
  restoreBoard: (id: string) => request<Wire<shared.BoardReply>>(`/boards/${id}/restore`, { method: "POST" }),
  purgeBoard: (id: string) => request<void>(`/boards/${id}/permanent`, { method: "DELETE" }),
  emptyTrash: () => request<void>("/boards/trash", { method: "DELETE" }),
  archiveBoards: (ids: string[], archived: boolean) =>
    request<Wire<shared.ArchiveReply>>("/boards/archive", { method: "PATCH", body: { ids, archived } }),
  forgetBoard: (id: string) => request<void>(`/boards/${id}/state`, { method: "DELETE" }),
  setLinkAccess: (id: string, linkAccess: LinkAccess) =>
    request<Wire<shared.BoardMetaReply>>(`/boards/${id}/link-access`, { method: "PATCH", body: { linkAccess } }),
  setLinkLock: (id: string, lock: { password?: string | null; expiresAt?: string | null; linkReplay?: boolean }) =>
    request<Wire<shared.BoardMetaReply>>(`/boards/${id}/link-access`, { method: "PATCH", body: lock }),
  // Gives the password a board's link asks for; answers with the pass that opens it (see lib/linkPasses.ts).
  unlockBoard: (id: string, password: string) =>
    request<shared.LinkPassReply>(`/boards/${id}/unlock`, { method: "POST", body: { password } }),
  inviteCollaborator: (id: string, email: string) =>
    request<Wire<shared.BoardMetaReply>>(`/boards/${id}/collaborators`, { method: "POST", body: { email } }),
  requestAccess: (id: string) => request<void>(`/boards/${id}/access-requests`, { method: "POST" }),
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
  reactToMessage: (id: string, threadId: string, messageId: string, emoji: string, on: boolean) =>
    request<Wire<shared.ThreadReply>>(`/boards/${id}/threads/${threadId}/messages/${messageId}/reactions`, {
      method: "PUT",
      body: { emoji, on },
    }),
  updateThread: (id: string, threadId: string, changes: Record<string, unknown>) =>
    request<Wire<shared.ThreadReply>>(`/boards/${id}/threads/${threadId}`, { method: "PATCH", body: changes }),
  deleteThread: (id: string, threadId: string) =>
    request<void>(`/boards/${id}/threads/${threadId}`, { method: "DELETE" }),

  listNotifications: (before?: string) =>
    request<NotificationPage>(`/notifications${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  markNotificationsRead: (ids?: string[]) =>
    request<void>("/notifications/read", { method: "POST", body: ids ? { ids } : {} }),
};
