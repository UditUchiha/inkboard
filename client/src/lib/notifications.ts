import type { NotificationItem } from "./api";

// How many notifications the server sends per page.
export const NOTIFICATION_LIMIT = 30;

/**
 * Combines notification lists (the fetched ones and the ones that arrived live) by id, newest first, keeping at most
 * `limit` (all of them by default: older pages are only there because someone asked for them). Reading is one-way:
 * read in either copy means read.
 */
export function mergeNotifications(current: NotificationItem[], incoming: NotificationItem[], limit = Infinity) {
  const byId = new Map<string, NotificationItem>();
  for (const notification of [...current, ...incoming]) {
    const seen = byId.get(notification.id);
    byId.set(notification.id, seen ? { ...seen, ...notification, read: seen.read || notification.read } : notification);
  }
  // Subtracting two Dates gives milliseconds, which TypeScript doesn't allow.
  // @ts-expect-error
  return [...byId.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
}

/**
 * The list after fetching the newest page again (on load and after every reconnect). Anything older than that page
 * is dropped rather than kept: notifications sent while offline could leave a gap between the two that paging
 * (which continues from the oldest one shown) would never fill. What arrived live meanwhile is newer, so it stays.
 * An empty page says nothing about how far back it reaches (the server can skip a whole page whose senders are gone
 * and still have older ones), so then nothing is dropped.
 */
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
