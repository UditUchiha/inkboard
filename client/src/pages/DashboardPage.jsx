import clsx from "clsx";
import { ArrowDownUp, Check, LayoutGrid, List, Plus, Search, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { AppHeader } from "../components/AppHeader";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/Dialog";
import { Menu, MenuItem, MenuLabel } from "../components/Menu";
import { APP_NAME } from "../config";
import { BoardCard } from "../features/dashboard/BoardCard";
import { BoardTable } from "../features/dashboard/BoardTable";
import { DashboardNav } from "../features/dashboard/DashboardNav";
import { RenameDialog } from "../features/dashboard/RenameDialog";
import { compareBoards, isMember, SECTIONS, SORT_KEYS } from "../features/dashboard/sections";
import { useBoards } from "../features/dashboard/useBoards";
import { useStoredState } from "../features/dashboard/useStoredState";
import { NewBoardDialog } from "../features/templates/NewBoardDialog";
import { api } from "../lib/api";
import { useAuth } from "../providers/AuthProvider";

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6 gap-y-8";

const quoted = (boards) => (boards.length === 1 ? `“${boards[0].title}”` : `${boards.length} boards`);

function TileSkeleton() {
  return (
    <li aria-hidden>
      <div className="aspect-[16/10] animate-pulse rounded-lg bg-ink/6" />
      <div className="mt-3 h-4 w-2/3 animate-pulse rounded bg-ink/6" />
      <div className="mt-2 h-3.5 w-1/3 animate-pulse rounded bg-ink/6" />
    </li>
  );
}

function ViewToggle({ view, onChange }) {
  return (
    <div role="group" aria-label="Layout" className="flex gap-1 rounded-lg bg-ink/5 p-1">
      {[
        ["grid", "Grid view", LayoutGrid],
        ["list", "List view", List],
      ].map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          aria-label={label}
          title={label}
          onClick={() => onChange(id)}
          className={clsx(
            "grid size-8 place-items-center rounded-md transition-colors",
            view === id ? "bg-surface text-ink shadow-sm" : "text-graphite hover:text-ink",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      ))}
    </div>
  );
}

function SortMenu({ sort, onChange }) {
  const tick = (on) => (on ? <Check className="size-4" /> : null);
  return (
    <Menu
      trigger={(props) => (
        <Button variant="secondary" icon={ArrowDownUp} {...props}>
          <span className="max-sm:sr-only">{SORT_KEYS[sort.key].label}</span>
        </Button>
      )}
    >
      <MenuLabel>Sort by</MenuLabel>
      {Object.entries(SORT_KEYS).map(([key, { label, defaultDir }]) => (
        <MenuItem key={key} hint={tick(sort.key === key)} onSelect={() => onChange({ key, dir: defaultDir })}>
          {label}
        </MenuItem>
      ))}
      <MenuLabel>Order</MenuLabel>
      {[
        ["asc", sort.key === "title" ? "A to Z" : "Oldest first"],
        ["desc", sort.key === "title" ? "Z to A" : "Newest first"],
      ].map(([dir, label]) => (
        <MenuItem key={dir} hint={tick(sort.dir === dir)} onSelect={() => onChange({ ...sort, dir })}>
          {label}
        </MenuItem>
      ))}
    </Menu>
  );
}

function BulkBar({ section, picked, actions, onClear }) {
  const owned = picked.every((board) => board.role === "owner");
  const members = picked.every(isMember);
  const trash = section.id === "trash";
  const archived = section.id === "archived";
  return (
    <div
      role="toolbar"
      aria-label="Actions for selected boards"
      className="floating-panel sticky top-20 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2"
    >
      <span className="mr-auto text-sm font-medium" aria-live="polite">
        {picked.length} selected
      </span>
      {trash ? (
        <>
          <Button size="sm" variant="secondary" onClick={() => actions.restore(picked)}>
            Restore
          </Button>
          <Button size="sm" variant="danger" onClick={() => actions.askPurge(picked)}>
            Delete forever
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="secondary" icon={Star} disabled={!members} title={members ? undefined : "Only people invited to a board can star it"} onClick={() => actions.starAll(picked)}>
            Star
          </Button>
          <Button size="sm" variant="secondary" onClick={() => actions.archive(picked, !archived)}>
            {archived ? "Unarchive" : "Archive"}
          </Button>
          <Button size="sm" variant="secondary" icon={Trash2} disabled={!owned} title={owned ? undefined : "Only the owner can move a board to the trash"} onClick={() => actions.trash(picked)}>
            Move to trash
          </Button>
        </>
      )}
      <Button size="sm" variant="ghost" icon={X} onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const section = SECTIONS.find((item) => item.id === params.get("show")) ?? SECTIONS[0];
  const inTrash = section.id === "trash";

  const { boards, trash, loadError, patch, drop, refresh } = useBoards();
  const [view, setView] = useStoredState("inkboard.dashboard.view", "grid");
  const [sort, setSort] = useStoredState("inkboard.dashboard.sort", { key: "modified", dir: "desc" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [creating, setCreating] = useState(false);
  const [choosing, setChoosing] = useState(false); // the "how should the new board start?" dialog
  const [renaming, setRenaming] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: "leave" | "purge" | "empty", boards }
  const [busy, setBusy] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    document.title = `${section.label} · ${APP_NAME}`;
  }, [section.label]);

  // "/" jumps to search, as on most sites with a lot of things to find.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => setSelected(new Set()), [section.id, query, view]);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        SECTIONS.map((item) => [item.id, item.id === "trash" ? trash.length : (boards ?? []).filter(item.matches).length]),
      ),
    [boards, trash],
  );

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const source = inTrash ? trash : (boards ?? []).filter(section.matches);
    const found = source.filter(
      (board) => !term || board.title.toLowerCase().includes(term) || board.owner.name.toLowerCase().includes(term),
    );
    return inTrash ? found : found.sort(compareBoards(sort));
  }, [boards, trash, inTrash, section, query, sort]);

  const picked = visible.filter((board) => selected.has(board.id));

  // Every change shows up at once; if the server refuses it, it's put back and the person is told.
  const actions = {
    rename: setRenaming,
    askLeave: (board) => setConfirm({ kind: "leave", boards: [board] }),
    askPurge: (list) => setConfirm({ kind: "purge", boards: list }),

    async copyLink(board) {
      try {
        await navigator.clipboard.writeText(`${window.location.origin}/board/${board.id}`);
        toast.success("Link copied");
      } catch {
        toast.error("Couldn't copy the link.");
      }
    },

    async toggleStar(board) {
      const starred = !board.starred;
      patch([board.id], { starred });
      try {
        await api.starBoard(board.id, starred);
      } catch (error) {
        patch([board.id], { starred: !starred });
        toast.error(error.message);
      }
    },

    async starAll(list) {
      const starred = !list.every((board) => board.starred);
      patch(list.map((board) => board.id), { starred });
      setSelected(new Set());
      const results = await Promise.allSettled(list.map((board) => api.starBoard(board.id, starred)));
      results.forEach((result, index) => {
        if (result.status === "rejected") patch([list[index].id], { starred: !starred });
      });
      if (results.some((result) => result.status === "rejected")) toast.error("Some boards couldn't be updated.");
    },

    async archive(list, archived) {
      const before = list.map((board) => [board.id, board.archived]);
      patch(list.map((board) => board.id), { archived });
      try {
        await api.archiveBoards(list.map((board) => board.id), archived);
      } catch (error) {
        before.forEach(([id, was]) => patch([id], { archived: was }));
        toast.error(error.message);
        return;
      }
      setSelected(new Set());
      toast(archived ? `Archived ${quoted(list)}` : `Moved ${quoted(list)} out of the archive`, {
        action: { label: "Undo", onClick: () => actions.archive(list, !archived) },
      });
    },

    async trash(list) {
      const results = await Promise.allSettled(list.map((board) => api.deleteBoard(board.id)));
      const done = list.filter((_, index) => results[index].status === "fulfilled");
      if (done.length < list.length) toast.error("Some boards couldn't be moved to the trash.");
      if (done.length === 0) return;
      drop(done.map((board) => board.id));
      setSelected(new Set());
      refresh().catch(() => {});
      toast(`Moved ${quoted(done)} to the trash`, { action: { label: "Undo", onClick: () => actions.restore(done, true) } });
    },

    async restore(list, quiet = false) {
      const results = await Promise.allSettled(list.map((board) => api.restoreBoard(board.id)));
      if (results.some((result) => result.status === "rejected")) toast.error("Some boards couldn't be restored.");
      setSelected(new Set());
      await refresh().catch(() => {});
      if (!quiet) toast.success(`Restored ${quoted(list)}`);
    },

    async forget(board) {
      try {
        await api.forgetBoard(board.id);
        drop([board.id]);
        toast(`Removed “${board.title}” from your list`, { description: "Open its link again to bring it back." });
      } catch (error) {
        toast.error(error.message);
      }
    },
  };

  // `input` says how to start: {} for blank, { title, elements } or { templateId }.
  async function createBoard(input = {}) {
    setCreating(true);
    try {
      const { board } = await api.createBoard(input);
      navigate(`/board/${board.id}`);
    } catch (error) {
      toast.error(error.message);
      setCreating(false);
    }
  }

  async function confirmAction() {
    const { kind, boards: targets } = confirm;
    setBusy(true);
    try {
      if (kind === "leave") {
        await api.removeCollaborator(targets[0].id, "me");
        drop([targets[0].id]);
        toast.success(`Left “${targets[0].title}”`);
      } else if (kind === "empty") {
        await api.emptyTrash();
        await refresh();
        toast.success("Trash emptied");
      } else {
        const results = await Promise.allSettled(targets.map((board) => api.purgeBoard(board.id)));
        await refresh();
        setSelected(new Set());
        if (results.some((result) => result.status === "rejected")) toast.error("Some boards couldn't be deleted.");
        else toast.success(`Deleted ${quoted(targets)} forever`);
      }
      setConfirm(null);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  const confirmCopy = {
    leave: {
      title: `Leave “${confirm?.boards[0].title}”?`,
      description: "You'll lose access until the owner invites you again.",
      label: "Leave board",
    },
    purge: {
      title: confirm?.boards.length === 1 ? `Delete “${confirm.boards[0].title}” forever?` : `Delete ${confirm?.boards.length} boards forever?`,
      description: "The drawings, comments and history are erased for everyone. This can't be undone.",
      label: "Delete forever",
    },
    empty: {
      title: "Empty the trash?",
      description: `${trash.length === 1 ? "1 board" : `${trash.length} boards`} will be erased forever, with their comments and history. This can't be undone.`,
      label: "Empty trash",
    },
  }[confirm?.kind ?? "leave"];

  const firstName = user.name.split(" ")[0];
    const loading = !boards && !loadError;

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-5 px-4 pt-8 pb-20 sm:px-6 md:grid-cols-[13.5rem_minmax(0,1fr)]">
        <DashboardNav activeId={section.id} counts={counts} onCreate={() => setChoosing(true)} creating={creating} />

        <main className="min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-[2rem] leading-none font-extrabold tracking-tight [font-stretch:80%]">{section.label}</h1>
              <p className="mt-2 text-graphite">{section.description(firstName)}</p>
            </div>
            <Button icon={Plus} onClick={() => setChoosing(true)} loading={creating} className="md:hidden">
              New board
            </Button>
            {inTrash && trash.length > 0 && (
              <Button variant="secondary" icon={Trash2} onClick={() => setConfirm({ kind: "empty", boards: trash })}>
                Empty trash
              </Button>
            )}
          </div>

          <div className="mt-6 flex items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search boards</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-graphite" aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${section.label.toLowerCase()}`}
                className="peer h-10 w-full rounded-lg border border-rule bg-surface pr-3 pl-9 text-sm transition-colors placeholder:text-graphite/70 focus:border-signal focus:ring-3 focus:ring-signal/20 focus:outline-none"
              />
              <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border border-rule px-1.5 font-code text-xs text-graphite peer-focus:hidden sm:block">/</kbd>
            </label>
            {!inTrash && <SortMenu sort={sort} onChange={setSort} />}
            <ViewToggle view={view} onChange={setView} />
          </div>

          <div className="mt-5">
            {loadError && (
              <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-6">
                <p className="font-medium text-danger">Your boards couldn't be loaded.</p>
                <p className="mt-1 text-sm text-graphite">{loadError}</p>
                <Button variant="secondary" size="sm" className="mt-4" onClick={() => window.location.reload()}>
                  Reload
                </Button>
              </div>
            )}

            {loading && (
              <ul className={GRID}>
                {Array.from({ length: 6 }, (_, index) => (
                  <TileSkeleton key={index} />
                ))}
              </ul>
            )}

            {boards && visible.length === 0 && (
              query ? (
                <p className="mt-16 text-center text-graphite">No boards match “{query.trim()}”.</p>
              ) : (
                <div className="graph-paper grid place-items-center rounded-xl border border-dashed border-graphite/40 px-6 py-20 text-center">
                  <h2 className="text-xl font-bold">{section.empty.title}</h2>
                  <p className="mt-2 max-w-sm text-graphite">{section.empty.text}</p>
                  {section.id === "all" || section.id === "yours" ? (
                    <Button icon={Plus} onClick={() => setChoosing(true)} loading={creating} className="mt-6">
                      Create a board
                    </Button>
                  ) : null}
                </div>
              )
            )}

            {visible.length > 0 && view === "list" && (
              <>
                {picked.length > 0 && (
                  <BulkBar section={section} picked={picked} actions={actions} onClear={() => setSelected(new Set())} />
                )}
                <BoardTable
                  boards={visible}
                  trashed={inTrash}
                  sort={sort}
                  onSort={(key) =>
                    setSort(sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: SORT_KEYS[key].defaultDir })
                  }
                  selected={selected}
                  onToggle={(id) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (!next.delete(id)) next.add(id);
                      return next;
                    })
                  }
                  onToggleAll={() => setSelected(picked.length === visible.length ? new Set() : new Set(visible.map((board) => board.id)))}
                  actions={actions}
                />
              </>
            )}

            {visible.length > 0 && view === "grid" && (
              <ul className={GRID}>
                {visible.map((board) => (
                  <BoardCard key={board.id} board={board} trashed={inTrash} actions={actions} />
                ))}
              </ul>
            )}
          </div>
        </main>
      </div>

      <NewBoardDialog open={choosing} onClose={() => setChoosing(false)} onCreate={createBoard} busy={creating} signedIn />
      <RenameDialog
        board={renaming}
        onClose={() => setRenaming(null)}
        onRenamed={(updated) => patch([updated.id], { title: updated.title, updatedAt: updated.updatedAt })}
      />
      <ConfirmDialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        onConfirm={confirmAction}
        busy={busy}
        title={confirmCopy.title}
        description={confirmCopy.description}
        confirmLabel={confirmCopy.label}
      />
    </div>
  );
}
