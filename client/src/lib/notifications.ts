import type { NotificationItem } from "./api";

export const NOTIFICATION_LIMIT = 30;

// Newest first, deduped by id; read in either copy means read. Older pages are only kept because someone asked, so `limit` defaults to all.
export function mergeNotifications(current: NotificationItem[], incoming: NotificationItem[], limit = Infinity) {
  const byId = new Map<string, NotificationItem>();
  for (const notification of [...current, ...incoming]) {
    const seen = byId.get(notification.id);
    byId.set(notification.id, seen ? { ...seen, ...notification, read: seen.read || notification.read } : notification);
  }
  return [...byId.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

// Anything older than the refetched newest page is dropped: notifications sent while offline could leave a gap paging would never fill.
// An empty page says nothing about how far back it reaches (the server skips pages whose senders are gone), so nothing is dropped.
export function withNewestPage(current: NotificationItem[], page: NotificationItem[]) {
  const oldest = page.at(-1);
  if (!oldest) return current;
  const cutoff = new Date(oldest.createdAt);
  return mergeNotifications(
    current.filter((item) => new Date(item.createdAt) >= cutoff),
    page,
  );
}

export const unreadIds = (notifications: NotificationItem[]) =>
  notifications.filter((item) => !item.read).map((item) => item.id);
