import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, setAuthToken, setUnauthorizedHandler } from "../lib/api";

const TOKEN_KEY = "inkboard.token";

const AuthContext = createContext(null);

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode): the session lasts until reload.
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(readToken);
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(token ? "loading" : "anonymous");
  const [attempt, setAttempt] = useState(0);

  setAuthToken(token);

  const logout = useCallback(() => {
    writeToken(null);
    setToken(null);
    setUser(null);
    setStatus("anonymous");
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  useEffect(() => {
    if (!token || user) return;
    let active = true;
    api
      .me()
      .then(({ user: me }) => {
        if (!active) return;
        setUser(me);
        setStatus("authenticated");
      })
      .catch((error) => {
        if (!active) return;
        if (error.status === 401) logout();
        else setStatus("offline");
      });
    return () => {
      active = false;
    };
  }, [token, user, logout, attempt]);

  const retry = useCallback(() => {
    setStatus("loading");
    setAttempt((count) => count + 1);
  }, []);

  const startSession = useCallback(({ token: nextToken, user: nextUser }) => {
    writeToken(nextToken);
    setAuthToken(nextToken);
    setToken(nextToken);
    setUser(nextUser);
    setStatus("authenticated");
  }, []);

  // Google and GitHub sign-in return only a token; the account is loaded by the effect above.
  const adoptToken = useCallback((nextToken) => {
    writeToken(nextToken);
    setAuthToken(nextToken);
    setToken(nextToken);
    setUser(null);
    setStatus("loading");
  }, []);

  const value = useMemo(
    () => ({
      user,
      token,
      status,
      login: async (input) => startSession(await api.login(input)),
      register: async (input) => startSession(await api.register(input)),
      // Starts a session from `{ token, user }`, as a password reset returns.
      startSession,
      adoptToken,
      updateUser: setUser,
      logout,
      retry,
    }),
    [user, token, status, startSession, adoptToken, logout, retry],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}
