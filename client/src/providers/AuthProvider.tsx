import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { api, setAuthToken, setUnauthorizedHandler } from "../lib/api";
import type { AccountUser, ApiError, LoginInput, RegisterInput, Session } from "../lib/api";
import { logoutPlan } from "../lib/session";

const TOKEN_KEY = "inkboard.token";

export type AuthStatus = "loading" | "anonymous" | "authenticated" | "offline";

export type AuthValue = {
  user: AccountUser | null;
  token: string | null;
  status: AuthStatus;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  startSession: (session: Session) => void;
  updateUser: Dispatch<SetStateAction<AccountUser | null>>;
  logout: () => void;
  retry: () => void;
};

// Exported for tests, which render pages with an account in a state of their choosing.
export const AuthContext = createContext<AuthValue | null>(null);

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode): the session lasts until reload.
  }
}

type AuthProviderProps = { children: ReactNode };

export function AuthProvider({ children }: AuthProviderProps) {
  const [token, setToken] = useState(readToken);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>(token ? "loading" : "anonymous");
  const [attempt, setAttempt] = useState(0);

  setAuthToken(token);
  const tokenRef = useRef(token);
  useLayoutEffect(() => {
    tokenRef.current = token;
  });

  // See logoutPlan. When the server refused this tab's token, a newer login for the same account stored by another tab is followed rather than lost.
  const endSession = useCallback((explicit: boolean) => {
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

  // The `storage` event only fires in other tabs: follow it so this tab neither keeps an ended login nor an old one.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
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
      .catch((error: ApiError) => {
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

  const startSession = useCallback(({ token: nextToken, user: nextUser }: Session) => {
    writeToken(nextToken);
    setAuthToken(nextToken);
    setToken(nextToken);
    setUser(nextUser);
    setStatus("authenticated");
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      token,
      status,
      login: async (input) => startSession(await api.login(input)),
      register: async (input) => startSession(await api.register(input)),
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
