import { API_URL } from "../config";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let authToken = null;
let onUnauthorized = () => {};

export function setAuthToken(token) {
  authToken = token;
}

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

async function request(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // The login this request is made with: if it's refused, only that login is over, not one made since.
  const sentWith = authToken;
  if (sentWith) headers.Authorization = `Bearer ${sentWith}`;

  let response;
  try {
    response = await fetch(`${API_URL}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }

  const data = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    // A late answer to a request made before the person logged in again must not log the new login out
    // (another tab may have changed it, or a password change just replaced it).
    if (response.status === 401 && sentWith && sentWith === authToken) onUnauthorized();
    throw new ApiError(response.status, data?.error ?? "Something went wrong. Try again.");
  }
  return data;
}

export const api = {
  register: (input) => request("/auth/register", { method: "POST", body: input }),
  login: (input) => request("/auth/login", { method: "POST", body: input }),
  me: () => request("/auth/me"),
  updateProfile: (input) => request("/auth/me", { method: "PATCH", body: input }),
  changePassword: (input) => request("/auth/password", { method: "POST", body: input }),
  verifyEmail: (token) => request("/auth/verify-email", { method: "POST", body: { token } }),
  resendVerification: () => request("/auth/verify-email/resend", { method: "POST" }),
  forgotPassword: (email) => request("/auth/forgot-password", { method: "POST", body: { email } }),
  resetPassword: (input) => request("/auth/reset-password", { method: "POST", body: input }),
  listProviders: () => request("/auth/providers"),
  // Returns { url, bind }: the URL starts connecting the provider to the signed-in account, and `bind`
  // is kept in the tab to hand back with what comes back (confirmProviderLink).
  linkProvider: (provider) => request(`/auth/oauth/${provider}/link`, { method: "POST" }),
  // `input` is { connect, bind }: the note the provider's sign-in came back with, and the tab's `bind`.
  confirmProviderLink: (provider, input) =>
    request(`/auth/oauth/${provider}/link/confirm`, { method: "POST", body: input }),
  // `input` is { code, bind }: the sign-in code from the OAuth redirect, and the `bind` this tab kept when it
  // started signing in. Returns { token, user }.
  exchangeOAuthCode: (input) => request("/auth/oauth/exchange", { method: "POST", body: input }),
  logoutEverywhere: () => request("/auth/logout-everywhere", { method: "POST" }),
  disconnectProvider: (provider) => request(`/auth/oauth/${provider}`, { method: "DELETE" }),

  listBoards: () => request("/boards"),
  // Previews (a light copy of each drawing, to draw cards from) of up to 24 boards, as { previews: { [id]: elements } }.
  boardPreviews: (ids) => request(`/boards/previews?ids=${ids.join(",")}`),
  // `input` is a title, or { title, elements } / { title, templateId }.
  createBoard: (input = {}) =>
    request("/boards", { method: "POST", body: typeof input === "string" ? { title: input } : input }),
  renameBoard: (id, title) => request(`/boards/${id}`, { method: "PATCH", body: { title } }),
  // Moves the board to the owner's trash (everyone loses access until it's restored).
  deleteBoard: (id) => request(`/boards/${id}`, { method: "DELETE" }),
  starBoard: (id, starred) => request(`/boards/${id}/star`, { method: "PUT", body: { starred } }),
  listTrash: () => request("/boards/trash"),
  restoreBoard: (id) => request(`/boards/${id}/restore`, { method: "POST" }),
  purgeBoard: (id) => request(`/boards/${id}/permanent`, { method: "DELETE" }),
  emptyTrash: () => request("/boards/trash", { method: "DELETE" }),
  // Archive or unarchive boards for this person only.
  archiveBoards: (ids, archived) => request("/boards/archive", { method: "PATCH", body: { ids, archived } }),
  // Drop a board from this person's dashboard (used for boards they only opened from a link).
  forgetBoard: (id) => request(`/boards/${id}/state`, { method: "DELETE" }),
  setLinkAccess: (id, linkAccess) => request(`/boards/${id}/link-access`, { method: "PATCH", body: { linkAccess } }),
  inviteCollaborator: (id, email) => request(`/boards/${id}/collaborators`, { method: "POST", body: { email } }),
  removeCollaborator: (id, userId) => request(`/boards/${id}/collaborators/${userId}`, { method: "DELETE" }),

  listVersions: (id) => request(`/boards/${id}/versions`),
  getVersion: (id, versionId) => request(`/boards/${id}/versions/${versionId}`),
  saveVersion: (id, label) => request(`/boards/${id}/versions`, { method: "POST", body: { label } }),
  restoreVersion: (id, versionId) => request(`/boards/${id}/versions/${versionId}/restore`, { method: "POST" }),
  deleteVersion: (id, versionId) => request(`/boards/${id}/versions/${versionId}`, { method: "DELETE" }),

  listTemplates: () => request("/templates"),
  saveTemplate: (boardId, title) => request("/templates", { method: "POST", body: { boardId, title } }),
  deleteTemplate: (id) => request(`/templates/${id}`, { method: "DELETE" }),

  listThreads: (id) => request(`/boards/${id}/threads`),
  createThread: (id, input) => request(`/boards/${id}/threads`, { method: "POST", body: input }),
  replyToThread: (id, threadId, input) =>
    request(`/boards/${id}/threads/${threadId}/messages`, { method: "POST", body: input }),
  updateThread: (id, threadId, changes) =>
    request(`/boards/${id}/threads/${threadId}`, { method: "PATCH", body: changes }),
  deleteThread: (id, threadId) => request(`/boards/${id}/threads/${threadId}`, { method: "DELETE" }),

  // The newest page, or with `before` (the id of the oldest one shown) the page after it.
  listNotifications: (before) => request(`/notifications${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  markNotificationsRead: (ids) => request("/notifications/read", { method: "POST", body: ids ? { ids } : {} }),
};
