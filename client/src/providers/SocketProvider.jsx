import { createContext, useContext, useEffect, useState } from "react";
import { io } from "socket.io-client";
import { API_URL } from "../config";
import { useAuth } from "./AuthProvider";

const SocketContext = createContext(null);

// One authenticated connection per login session, shared by every board.
export function SocketProvider({ children }) {
  const { token, logout } = useAuth();
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    if (!token) return undefined;
    const options = { auth: { token } };
    const next = API_URL ? io(API_URL, options) : io(options);

    next.on("connect_error", (error) => {
      if (error.message === "unauthorized") logout();
    });

    setSocket(next);
    return () => {
      next.disconnect();
      setSocket(null);
    };
  }, [token, logout]);

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

export function useSocket() {
  return useContext(SocketContext);
}
