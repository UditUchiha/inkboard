import clsx from "clsx";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { Avatar } from "../../components/Avatar";
import { timeAgo } from "../../lib/format";
import { BoardMenu, RoleBadge, StarButton } from "./BoardParts";
import { daysLeft, isMember, SORT_KEYS } from "./sections";

function SortHeader({ id, sort, onSort, children, className }) {
  const active = sort.key === id;
  const Arrow = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
      className={clsx("px-3 py-2.5 font-medium", className)}
    >
      <button
        type="button"
        onClick={() => onSort(id)}
        className={clsx("inline-flex items-center gap-1 rounded-sm hover:text-ink", active && "text-ink")}
      >
        {children}
        {active && <Arrow className="size-3.5" aria-hidden />}
      </button>
    </th>
  );
}

/** The list view: one row per board, with checkboxes for acting on several at once. */
export function BoardTable({ boards, trashed = false, sort, onSort, selected, onToggle, onToggleAll, actions }) {
  const allRef = useRef(null);
  const chosen = boards.filter((board) => selected.has(board.id)).length;

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = chosen > 0 && chosen < boards.length;
  }, [chosen, boards.length]);

  const dateKey = sort.key === "opened" ? "opened" : "modified";

  return (
    <div className="rounded-xl border border-rule bg-surface">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-rule text-graphite">
          <tr>
            <th scope="col" className="w-10 py-2.5 pr-0 pl-4">
              <input
                ref={allRef}
                type="checkbox"
                checked={boards.length > 0 && chosen === boards.length}
                onChange={onToggleAll}
                aria-label="Select all boards"
                className="size-4 accent-[var(--signal)]"
              />
            </th>
            {trashed ? (
              <th scope="col" className="px-3 py-2.5 font-medium">
                Title
              </th>
            ) : (
              <SortHeader id="title" sort={sort} onSort={onSort}>
                Title
              </SortHeader>
            )}
            <th scope="col" className="px-3 py-2.5 font-medium max-sm:hidden">
              Owner
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium max-md:hidden">
              {trashed ? "Erased in" : "Access"}
            </th>
            {trashed ? (
              <th scope="col" className="px-3 py-2.5 font-medium">
                Deleted
              </th>
            ) : (
              <SortHeader id={dateKey} sort={sort} onSort={onSort}>
                {SORT_KEYS[dateKey].label}
              </SortHeader>
            )}
            <th scope="col" className="w-12 py-2.5 pr-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {boards.map((board) => {
            const isSelected = selected.has(board.id);
            const left = trashed ? daysLeft(board.purgeAt) : 0;
            return (
              <tr key={board.id} className={clsx("group transition-colors", isSelected ? "bg-signal/6" : "hover:bg-surface-2")}>
                <td className="py-2 pr-0 pl-4">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggle(board.id)}
                    aria-label={`Select ${board.title}`}
                    className="size-4 accent-[var(--signal)]"
                  />
                </td>
                <td className="max-w-0 min-w-40 px-3 py-2">
                  <div className="flex items-center gap-1">
                    {!trashed && isMember(board) && <StarButton board={board} onToggle={actions.toggleStar} className="-ml-1.5 shrink-0" />}
                    {trashed ? (
                      <span className="truncate font-medium">{board.title}</span>
                    ) : (
                      <Link to={`/board/${board.id}`} className="truncate rounded-sm font-medium hover:underline hover:underline-offset-4">
                        {board.title}
                      </Link>
                    )}
                    {board.archived && !trashed && <span className="shrink-0 text-xs text-graphite">Archived</span>}
                  </div>
                </td>
                <td className="px-3 py-2 max-sm:hidden">
                  <span className="flex items-center gap-2">
                    <Avatar id={board.owner.id} name={board.owner.name} size="xs" />
                    <span className="truncate">{board.role === "owner" ? "You" : board.owner.name}</span>
                  </span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap max-md:hidden">
                  {trashed ? (
                    <span className="text-graphite">{left === 1 ? "1 day" : `${left} days`}</span>
                  ) : (
                    <RoleBadge role={board.role} />
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-graphite">
                  {trashed
                    ? timeAgo(board.deletedAt)
                    : timeAgo(dateKey === "opened" ? (board.lastOpenedAt ?? board.updatedAt) : board.updatedAt)}
                </td>
                <td className="py-1 pr-3">
                  <BoardMenu board={board} trashed={trashed} actions={actions} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
