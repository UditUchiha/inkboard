export const APP_NAME = "Inkboard";

// Leave VITE_API_URL empty when the API is served from the same origin as the
// client (local dev through the Vite proxy, or the single-service deploy).
export const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
