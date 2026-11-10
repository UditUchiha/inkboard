import { Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { AppHeader } from "../components/AppHeader";
import { Button } from "../components/Button";
import { VerifyEmailNotice } from "../components/VerifyEmailNotice";
import { APP_NAME } from "../config";
import { BoardCard } from "../features/dashboard/components/BoardCard";
import { BoardConfirmDialog } from "../features/dashboard/components/BoardConfirmDialog";
import { BoardTable } from "../features/dashboard/components/BoardTable";
import { BulkBar } from "../features/dashboard/components/BulkBar";
import { DashboardNav } from "../features/dashboard/components/DashboardNav";
import { RenameDialog } from "../features/dashboard/components/RenameDialog";
import { SortMenu } from "../features/dashboard/components/SortMenu";
import { TileSkeleton } from "../features/dashboard/components/TileSkeleton";
import { ViewToggle } from "../features/dashboard/components/ViewToggle";
import { compareBoards, DEFAULT_SORT, isSort, isView, SECTIONS, SORT_KEYS } from "../features/dashboard/lib/sections";
import type { BoardSummary, SectionId, View } from "../features/dashboard/lib/sections";
import { useBoardActions } from "../features/dashboard/hooks/useBoardActions";
import { useBoards } from "../features/dashboard/hooks/useBoards";
import { useStoredState } from "../features/dashboard/hooks/useStoredState";
import type { Confirm } from "../features/dashboard/types/confirm";
import { NewBoardDialog } from "../features/templates/components/NewBoardDialog";
import { api, errorMessage } from "../lib/api";
import type { CreateBoardInput } from "../lib/api";
import { useAuth } from "../providers/AuthProvider";

// Every card downloads a preview, so people with hundreds of boards load them a page at a time.
const PAGE_SIZE = 48;

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6 gap-y-8";

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const section = SECTIONS.find((item) => item.id === params.get("show")) ?? SECTIONS[0];
  const inTrash = section.id === "trash";

  // useBoards types the trash as possibly undefined, but it starts as a list and only ever becomes another list.
  const { boards, trash, loadError, patch, drop, refresh, loadPreviews } = useBoards() as Omit<
    ReturnType<typeof useBoards>,
    "trash"
  > & { trash: BoardSummary[] };
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [view, setView] = useStoredState<View>("inkboard.dashboard.view", "grid", isView);
  const [sort, setSort] = useStoredState("inkboard.dashboard.sort", DEFAULT_SORT, isSort);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set<string>());
  const [creating, setCreating] = useState(false);
  const [choosing, setChoosing] = useState(false); // the "how should the new board start?" dialog
  const [renaming, setRenaming] = useState<BoardSummary | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null); // { kind: "leave" | "purge" | "empty", boards }
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = `${section.label} · ${APP_NAME}`;
  }, [section.label]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))
      )
        return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const [last, setLast] = useState({ sectionId: section.id, query, view, sort });
  if (last.sectionId !== section.id || last.query !== query || last.view !== view || last.sort !== sort) {
    const listChanged = last.sectionId !== section.id || last.query !== query;
    setLast({ sectionId: section.id, query, view, sort });
    if (listChanged || last.view !== view) setSelected(new Set());
    if (listChanged || last.sort !== sort) setLimit(PAGE_SIZE);
  }

  const counts = useMemo(
    () =>
      Object.fromEntries(
        SECTIONS.map((item) => [
          item.id,
          item.id === "trash" ? trash.length : (boards ?? []).filter(item.matches).length,
        ]),
      ) as Record<SectionId, number>,
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

  const shown = useMemo(() => visible.slice(0, limit), [visible, limit]);
  const picked = shown.filter((board) => selected.has(board.id));

  useEffect(() => {
    if (view === "grid") loadPreviews(shown);
  }, [shown, view, loadPreviews]);

  const actions = useBoardActions({
    patch,
    drop,
    refresh,
    onRename: setRenaming,
    onConfirm: setConfirm,
    clearSelection: () => setSelected(new Set()),
  });

  async function createBoard(input: CreateBoardInput = {}) {
    setCreating(true);
    try {
      const { board } = await api.createBoard(input);
      navigate(`/board/${board.id}`);
    } catch (error) {
      toast.error(errorMessage(error));
      setCreating(false);
    }
  }

  const firstName = user!.name.split(" ")[0];
  const loading = !boards && !loadError;

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-5 px-4 pt-8 pb-20 sm:px-6 md:grid-cols-[13.5rem_minmax(0,1fr)]">
        <DashboardNav activeId={section.id} counts={counts} onCreate={() => setChoosing(true)} creating={creating} />

        <main className="min-w-0">
          <VerifyEmailNotice className="mb-6" />
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-[2rem] leading-none font-extrabold tracking-tight [font-stretch:80%]">
                {section.label}
              </h1>
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
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-graphite"
                aria-hidden
              />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${section.label.toLowerCase()}`}
                className="peer h-10 w-full rounded-lg border border-rule bg-surface pr-3 pl-9 text-sm transition-colors placeholder:text-graphite/70 focus:border-signal focus:ring-3 focus:ring-signal/20 focus:outline-none"
              />
              <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border border-rule px-1.5 font-code text-xs text-graphite peer-focus:hidden sm:block">
                /
              </kbd>
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

            {boards &&
              visible.length === 0 &&
              (query ? (
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
              ))}

            {visible.length > 0 && view === "list" && (
              <>
                {picked.length > 0 && (
                  <BulkBar section={section} picked={picked} actions={actions} onClear={() => setSelected(new Set())} />
                )}
                <BoardTable
                  boards={shown}
                  trashed={inTrash}
                  sort={sort}
                  onSort={(key) =>
                    setSort(
                      sort.key === key
                        ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
                        : { key, dir: SORT_KEYS[key].defaultDir },
                    )
                  }
                  selected={selected}
                  onToggle={(id) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (!next.delete(id)) next.add(id);
                      return next;
                    })
                  }
                  onToggleAll={() =>
                    setSelected(picked.length === shown.length ? new Set() : new Set(shown.map((board) => board.id)))
                  }
                  actions={actions}
                />
              </>
            )}

            {visible.length > 0 && view === "grid" && (
              <ul className={GRID}>
                {shown.map((board) => (
                  <BoardCard key={board.id} board={board} trashed={inTrash} actions={actions} />
                ))}
              </ul>
            )}

            {visible.length > shown.length && (
              <div className="mt-8 flex justify-center">
                <Button variant="secondary" onClick={() => setLimit((current) => current + PAGE_SIZE)}>
                  Show more ({visible.length - shown.length} more)
                </Button>
              </div>
            )}
          </div>
        </main>
      </div>

      <NewBoardDialog open={choosing} onClose={() => setChoosing(false)} onCreate={createBoard} busy={creating} />
      <RenameDialog
        board={renaming}
        onClose={() => setRenaming(null)}
        onRenamed={(updated) => patch([updated.id], { title: updated.title, updatedAt: updated.updatedAt })}
      />
      <BoardConfirmDialog
        confirm={confirm}
        trashCount={trash.length}
        onClose={() => setConfirm(null)}
        drop={drop}
        refresh={refresh}
        clearSelection={() => setSelected(new Set())}
      />
    </div>
  );
}
