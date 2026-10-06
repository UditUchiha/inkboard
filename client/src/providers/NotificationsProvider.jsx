import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useAuth } from "./AuthProvider";
import { useSocket } from "./SocketProvider";

const NotificationsContext = createContext(null);

export const notificationLink = (notification) =>
  `/board/${notification.board.id}${notification.thread ? `?thread=${notification.thread}` : ""}`;

export function describeNotification({ type, actor, board }) {
  if (type === "mention") return `${actor.name} mentioned you on “${board.title}”`;
  if (type === "reply") return `${actor.name} replied to a comment on “${board.title}”`;
  return `${actor.name} invited you to “${board.title}”`;
}

/** Mentions, replies and invites for the signed-in person, live over the socket. */
export function NotificationsProvider({ children }) {
  const { status } = useAuth();
  const socket = useSocket();
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const signedIn = status === "authenticated";

  useEffect(() => {
    setItems([]);
    setUnread(0);
    if (!signedIn) return undefined;
    let active = true;
    api
      .listNotifications()
      .then((data) => {
        if (!active) return;
        setItems(data.notifications);
        setUnread(data.unread);
      })
      .catch(() => {}); // The bell just stays empty.
    return () => {
      active = false;
    };
  }, [signedIn]);

  useEffect(() => {
    if (!socket || !signedIn) return undefined;
    const onNotification = (notification) => {
      setItems((list) => [notification, ...list].slice(0, 30));
      setUnread((count) => count + 1);
      toast(describeNotification(notification), {
        description: notification.excerpt ?? undefined,
        action: { label: "Open", onClick: () => navigate(notificationLink(notification)) },
      });
    };
    socket.on("notification", onNotification);
    return () => socket.off("notification", onNotification);
  }, [socket, signedIn, navigate]);

  const markAllRead = useCallback(() => {
    setUnread(0);
    setItems((list) => list.map((item) => ({ ...item, read: true })));
    api.markNotificationsRead().catch(() => {});
  }, []);

  const value = useMemo(() => ({ items, unread, markAllRead }), [items, unread, markAllRead]);
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const context = useContext(NotificationsContext);
  if (!context) throw new Error("useNotifications must be used inside <NotificationsProvider>");
  return context;
}
