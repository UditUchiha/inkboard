import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api } from "../lib/api";
import { mergeNotifications, unreadIds, withNewestPage } from "../lib/notifications";
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
  const [more, setMore] = useState(false); // whether the server has older ones than those listed
  const [loadingMore, setLoadingMore] = useState(false);
  const signedIn = status === "authenticated";
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Bumped whenever the list starts over, so an older page that was on its way isn't added to the new list.
  const generation = useRef(0);
  // Where the next older page starts, as the server says: past every row it looked at, shown or not, so a page
  // whose notifications were all left out (their senders gone) can't send "Show older" round in a circle.
  const cursor = useRef(null);
  const unread = useMemo(() => unreadIds(items).length, [items]);

  // The next 30 older ones, from where the last page ended (or the oldest one listed, from a server without `next`).
  // Whether a page is on its way is a ref, so the callback stays the same and the effect below can use it.
  const loadingRef = useRef(false);
  const loadMore = useCallback(() => {
    const before = cursor.current ?? itemsRef.current.at(-1)?.id;
    if (!before || loadingRef.current) return;
    const started = generation.current;
    loadingRef.current = true;
    setLoadingMore(true);
    api
      .listNotifications(before)
      .then((data) => {
        if (generation.current !== started) return;
        setItems((list) => mergeNotifications(list, data.notifications));
        cursor.current = data.next ?? null;
        setMore(Boolean(data.more));
      })
      .catch(() => toast.error("Couldn't load older notifications. Try again."))
      .finally(() => {
        loadingRef.current = false;
        setLoadingMore(false);
      });
  }, []);

  // Loads what is saved and merges it with anything that arrived live meanwhile, now and after every reconnect
  // (notifications sent while the socket was down are only saved, not delivered).
  useEffect(() => {
    generation.current += 1;
    setItems([]);
    setMore(false);
    cursor.current = null;
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn) return undefined;
    let active = true;
    const refresh = () =>
      api
        .listNotifications()
        .then((data) => {
          if (!active) return;
          generation.current += 1;
          setItems((list) => withNewestPage(list, data.notifications));
          cursor.current = data.next ?? null;
          setMore(Boolean(data.more));
          // A first page with nothing to show but older ones behind it (every sender gone): fetch the next one now, so
          // the list isn't empty while notifications exist. Only once; "Show older" is there if that one is empty too.
          if (data.notifications.length === 0 && data.more) loadMore();
        })
        .catch(() => {}); // The bell just keeps what it has.
    if (!socket || socket.connected) refresh(); // otherwise the connect event below does
    socket?.on("connect", refresh);
    return () => {
      active = false;
      socket?.off("connect", refresh);
    };
  }, [signedIn, socket, loadMore]);

  useEffect(() => {
    if (!socket || !signedIn) return undefined;
    const onNotification = (notification) => {
      setItems((list) => mergeNotifications(list, [notification]));
      toast(describeNotification(notification), {
        description: notification.excerpt ?? undefined,
        action: { label: "Open", onClick: () => navigate(notificationLink(notification)) },
      });
    };
    socket.on("notification", onNotification);
    return () => socket.off("notification", onNotification);
  }, [socket, signedIn, navigate]);

  const markAllRead = useCallback(() => {
    const ids = unreadIds(itemsRef.current);
    if (ids.length === 0) return;
    setItems((list) => list.map((item) => ({ ...item, read: true })));
    api.markNotificationsRead(ids).catch(() => {});
  }, []);

  const value = useMemo(
    () => ({ items, unread, more, loadingMore, markAllRead, loadMore }),
    [items, unread, more, loadingMore, markAllRead, loadMore],
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const context = useContext(NotificationsContext);
  if (!context) throw new Error("useNotifications must be used inside <NotificationsProvider>");
  return context;
}
