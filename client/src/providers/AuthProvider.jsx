import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, setAuthToken, setUnauthorizedHandler } from "../lib/api";
import { logoutPlan } from "../lib/session";

const TOKEN_KEY = "inkboard.token";

// Exported for tests, which render pages with an account in a state of their choosing.
export const AuthContext = createContext(null);

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
  // The login this tab is using, for logout, which keeps one identity across renders.
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Ends this tab's login (see logoutPlan for what happens to the stored one). `explicit` is the person
  // choosing to log out: this tab then ends up logged out, whatever another tab has stored. When the
  // server refused this tab's token instead, a newer login for the same account that another tab just
  // stored (after a password change, say) is followed rather than lost.
  const endSession = useCallback((explicit) => {
    const { adopt, clearStored } = logoutPlan({ own: tokenRef.current, stored: readToken(), explicit });
    if (clearStored) writeToken(null);
    setAuthToken(adopt);
    setToken(adopt);
    setUser(null);
    setStatus(adopt ? "loading" : "anonymous");
  }, []);
  const logout = useCallback(() => endSession(true), [endSession]);
  const sessionRefused = useCallback(() => endSession(false), [endSession]);

  useEffect(() => {
    setUnauthorizedHandler(sessionRefused);
  }, [sessionRefused]);

  // Logging in or out in another tab changes the stored token (the `storage` event only fires in the
  // other tabs). Follow it, so this tab neither keeps a login that was ended nor keeps using an old one.
  useEffect(() => {
    function onStorage(event) {
      if (event.key !== TOKEN_KEY || event.newValue === token) return;
      setAuthToken(event.newValue);
      setToken(event.newValue);
      setUser(null);
      setStatus(event.newValue ? "loading" : "anonymous");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [token]);

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
        if (error.status === 401) sessionRefused();
        else setStatus("offline");
      });
    return () => {
      active = false;
    };
  }, [token, user, sessionRefused, attempt]);

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

  const value = useMemo(
    () => ({
      user,
      token,
      status,
      login: async (input) => startSession(await api.login(input)),
      register: async (input) => startSession(await api.register(input)),
      // Starts a session from `{ token, user }`, as a password reset or a finished Google or GitHub sign-in returns.
      startSession,
      updateUser: setUser,
      logout,
      retry,
    }),
    [user, token, status, startSession, logout, retry],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}
