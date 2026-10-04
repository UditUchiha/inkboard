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
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

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
    if (response.status === 401 && authToken) onUnauthorized();
    throw new ApiError(response.status, data?.error ?? "Something went wrong. Try again.");
  }
  return data;
}

export const api = {
  register: (input) => request("/auth/register", { method: "POST", body: input }),
  login: (input) => request("/auth/login", { method: "POST", body: input }),
  me: () => request("/auth/me"),

  listBoards: () => request("/boards"),
  createBoard: (title) => request("/boards", { method: "POST", body: { title } }),
  renameBoard: (id, title) => request(`/boards/${id}`, { method: "PATCH", body: { title } }),
  deleteBoard: (id) => request(`/boards/${id}`, { method: "DELETE" }),
  inviteCollaborator: (id, email) =>
    request(`/boards/${id}/collaborators`, { method: "POST", body: { email } }),
  removeCollaborator: (id, userId) =>
    request(`/boards/${id}/collaborators/${userId}`, { method: "DELETE" }),
};
