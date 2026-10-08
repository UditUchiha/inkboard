import clsx from "clsx";
import { Bell } from "lucide-react";
import { useNavigate } from "react-router";
import { timeAgo } from "../lib/format";
import { describeNotification, notificationLink, useNotifications } from "../providers/NotificationsProvider";
import { Avatar } from "./Avatar";
import { Menu } from "./Menu";

export function NotificationsMenu({ className }) {
  const { items, unread, markAllRead } = useNotifications();
  const navigate = useNavigate();

  return (
    <Menu
      className="w-[min(22rem,calc(100vw-2rem))]"
      trigger={({ onClick, ...props }) => (
        <button
          type="button"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
          className={clsx(
            "relative grid size-10 place-items-center rounded-lg text-ink transition-colors hover:bg-ink/6",
            className,
          )}
          onClick={() => {
            onClick();
            if (unread) markAllRead();
          }}
          {...props}
        >
          <Bell className="size-[18px]" strokeWidth={1.75} aria-hidden />
          {unread > 0 && (
            <span className="absolute top-1.5 right-1.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      )}
    >
      <p className="px-2.5 pt-2 pb-1 text-sm font-semibold">Notifications</p>
      {items.length === 0 ? (
        <p className="px-2.5 pt-1 pb-3 text-sm text-graphite">
          Nothing yet. You'll hear here when someone mentions you, replies to you or invites you to a board.
        </p>
      ) : (
        <ul className="max-h-[min(26rem,60vh)] overflow-y-auto">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                role="menuitem"
                onClick={() => navigate(notificationLink(item))}
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
                  <span className={clsx("block text-sm", !item.read && "font-semibold")}>
                    {describeNotification(item)}
                  </span>
                  {item.excerpt && <span className="block truncate text-sm text-graphite">{item.excerpt}</span>}
                  <span className="block text-xs text-graphite">{timeAgo(item.createdAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Menu>
  );
}
