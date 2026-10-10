import clsx from "clsx";
import { Bell } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { timeAgo } from "../lib/format";
import { useMinute } from "../lib/useMinute";
import { describeNotification, notificationLink, useNotifications } from "../providers/NotificationsProvider";
import { Avatar } from "./Avatar";
import { Menu, useCloseMenu } from "./Menu";

function NotificationItem({ item }) {
  const navigate = useNavigate();
  const closeMenu = useCloseMenu();
  useMinute();
  return (
    <li>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          closeMenu();
          navigate(notificationLink(item));
        }}
        className="flex w-full gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-ink/6 focus-visible:bg-ink/6 focus-visible:outline-none"
      >
        <Avatar
          id={item.actor.id}
          name={item.actor.name}
          color={item.actor.color}
          src={item.actor.avatarUrl}
          size="sm"
          decorative
        />
        <span className="min-w-0 flex-1">
          <span className={clsx("block text-sm", !item.read && "font-semibold")}>{describeNotification(item)}</span>
          {item.excerpt && <span className="block truncate text-sm text-graphite">{item.excerpt}</span>}
          <span className="block text-xs text-graphite">{timeAgo(item.createdAt)}</span>
        </span>
        {!item.read && (
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-signal" role="img" aria-label="Unread" />
        )}
      </button>
    </li>
  );
}

/**
 * The "Show older notifications" item. Loading the last page removes it, and a removed focused element drops focus to
 * the page body, which would end the menu's arrow-key handling. So when it goes away while focused, `onLostFocus`
 * is told, and the menu puts focus back on one of its items.
 */
function ShowOlderItem({ loading, onClick, onLostFocus }) {
  const ref = useRef(null);
  const lost = useRef(onLostFocus);
  lost.current = onLostFocus;
  useLayoutEffect(() => {
    const button = ref.current;
    return () => document.activeElement === button && lost.current();
  }, []);
  return (
    <li>
      {/* Not a MenuItem: loading more keeps the menu open. aria-disabled, not disabled, so focus stays on it. */}
      <button
        ref={ref}
        type="button"
        role="menuitem"
        onClick={onClick}
        aria-disabled={loading || undefined}
        className="w-full rounded-lg px-2.5 py-2 text-center text-sm font-medium text-signal transition-colors hover:bg-ink/6 focus-visible:bg-ink/6 focus-visible:outline-none aria-disabled:opacity-50"
      >
        {loading ? "Loading…" : "Show older notifications"}
      </button>
    </li>
  );
}

// Opening the menu shows what is new; closing it (or leaving the page with it open) counts everything as seen.
export function NotificationsMenu({ className }) {
  const { items, unread, more, loadingMore, markAllRead, loadMore } = useNotifications();
  const listRef = useRef(null);
  const refocus = useRef(false);

  // Once the list has its new items, focus the last one (the end of what was just loaded) if the button had focus.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    listRef.current?.querySelector('li:last-child [role="menuitem"]')?.focus();
  });

  return (
    <Menu
      className="w-[min(22rem,calc(100vw-2rem))]"
      onOpenChange={(open) => {
        refocus.current = false; // a pending refocus belongs to the menu that was open, not the next one
        if (!open) markAllRead();
      }}
      trigger={(props) => (
        <button
          type="button"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
          className={clsx(
            "relative grid size-10 place-items-center rounded-lg text-ink transition-colors hover:bg-ink/6",
            className,
          )}
          {...props}
        >
          <Bell className="size-[18px]" strokeWidth={1.75} aria-hidden />
          {unread > 0 && (
            <span className="absolute top-1.5 right-1.5 grid min-w-4 place-items-center rounded-full bg-danger-solid px-1 text-[10px] leading-4 font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      )}
    >
      <p className="px-2.5 pt-2 pb-1 text-sm font-semibold">Notifications</p>
      {items.length === 0 && !more ? (
        <p className="px-2.5 pt-1 pb-3 text-sm text-graphite">
          Nothing yet. You'll hear here when someone mentions you, replies to you or invites you to a board.
        </p>
      ) : (
        // With `more` the list can be empty: the server skips a page whose senders are all gone, and older ones remain.
        <ul ref={listRef} className="max-h-[min(26rem,60vh)] overflow-y-auto">
          {items.map((item) => (
            <NotificationItem key={item.id} item={item} />
          ))}
          {more && (
            <ShowOlderItem
              loading={loadingMore}
              onClick={loadMore}
              onLostFocus={() => {
                refocus.current = true;
              }}
            />
          )}
        </ul>
      )}
    </Menu>
  );
}
