import { createContext, useContext, useEffect, useState } from "react";
import { useMatch } from "react-router";
import { io } from "socket.io-client";
import { API_URL } from "../config";
import { getGuest } from "../lib/guest";
import { useAuth } from "./AuthProvider";

const SocketContext = createContext(null);

// One connection per login session, shared by every board. Signed-out visitors
// only connect on a board page, where they can open boards shared by link under
// a guest name. `auth` is a function so a reconnect sends their latest name.
export function SocketProvider({ children }) {
  const { token, logout } = useAuth();
  const onBoardPage = Boolean(useMatch("/board/:boardId"));
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    if (!token && !onBoardPage) return undefined;
    const options = token ? { auth: { token } } : { auth: (send) => send({ guest: getGuest() }) };
    const next = API_URL ? io(API_URL, options) : io(options);

    next.on("connect_error", (error) => {
      if (error.message === "unauthorized") logout();
    });

    setSocket(next);
    return () => {
      next.disconnect();
      setSocket(null);
    };
  }, [token, onBoardPage, logout]);

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

export function useSocket() {
  return useContext(SocketContext);
}
