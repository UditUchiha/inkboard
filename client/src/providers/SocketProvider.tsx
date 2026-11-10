import type { Wire } from "@inkboard/shared/api";
import type { ClientToServerEvents, ServerToClientEvents } from "@inkboard/shared/socket";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useMatch } from "react-router";
import { io } from "socket.io-client";
import type { ManagerOptions, Socket, SocketOptions } from "socket.io-client";
import { API_URL } from "../config";
import { getGuest } from "../lib/guest";
import { useAuth } from "./AuthProvider";

// Payloads arrive through JSON, which turns a Date into its ISO string, so events are declared in
// @inkboard/shared/socket as the server builds them and read here as Wire.
type WireParams<Params extends unknown[]> = { [Index in keyof Params]: Wire<Params[Index]> };

type ServerEvents = {
  [Event in keyof ServerToClientEvents]: (...args: WireParams<Parameters<ServerToClientEvents[Event]>>) => void;
};

type WireReplies<Args extends unknown[]> = {
  [Index in keyof Args]: Args[Index] extends (...reply: infer Reply) => void
    ? (...reply: WireParams<Reply>) => void
    : Args[Index];
};
type ClientEvents = {
  [Event in keyof ClientToServerEvents]: (...args: WireReplies<Parameters<ClientToServerEvents[Event]>>) => void;
};

export type AppSocket = Socket<ServerEvents, ClientEvents>;

const SocketContext = createContext<AppSocket | null>(null);

// One connection per login, shared by every board and kept while signed in (it carries notifications too); signed-out
// visitors
// only connect on a board page. `auth` is a function so a reconnect sends their latest name.
type SocketProviderProps = { children: ReactNode };

export function SocketProvider({ children }: SocketProviderProps) {
  const { token, logout } = useAuth();
  const onBoardPage = Boolean(useMatch("/board/:boardId"));
  // Signed in, this stays true on every page: going into or out of a board must not
  // reconnect, or notifications sent in between are lost.
  const needsSocket = Boolean(token) || onBoardPage;
  const [socket, setSocket] = useState<AppSocket | null>(null);

  useEffect(() => {
    if (!needsSocket) return undefined;
    const options: Partial<ManagerOptions & SocketOptions> = token
      ? { auth: { token } }
      : { auth: (send) => send({ guest: getGuest() }) };
    const next: AppSocket = API_URL ? io(API_URL, options) : io(options);

    next.on("connect_error", (error) => {
      if (error.message === "unauthorized") logout();
    });

    // eslint-disable-next-line react-hooks/set-state-in-effect -- the socket is an outside resource created here and
    // shared once it exists
    setSocket(next);
    return () => {
      next.disconnect();
      setSocket(null);
    };
  }, [token, needsSocket, logout]);

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

export function useSocket() {
  return useContext(SocketContext);
}
