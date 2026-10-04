import clsx from "clsx";
import { DoorOpen, Ellipsis, ExternalLink, PencilLine, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { AppHeader } from "../components/AppHeader";
import { AvatarStack } from "../components/Avatar";
import { Button } from "../components/Button";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { TextField } from "../components/Field";
import { Menu, MenuItem, MenuSeparator } from "../components/Menu";
import { APP_NAME } from "../config";
import { BoardPreview } from "../features/board/BoardPreview";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useAuth } from "../providers/AuthProvider";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "mine", label: "Owned by you" },
  { id: "shared", label: "Shared with you" },
];

function BoardTile({ board, onRename, onRemove }) {
  const members = [board.owner, ...board.collaborators];
  const isOwner = board.role === "owner";

  return (
    <li className="group">
      <Link
        to={`/board/${board.id}`}
        className="graph-paper block overflow-hidden rounded-lg border border-rule transition-colors [--cell:16px] hover:border-ink"
      >
        <BoardPreview elements={board.elements} className="aspect-[16/10]">
          {board.elements.length === 0 && (
            <span className="absolute inset-0 grid place-items-center text-sm text-graphite">Empty board</span>
          )}
        </BoardPreview>
      </Link>
      <div className="mt-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">
            <Link to={`/board/${board.id}`} className="rounded-sm hover:underline hover:underline-offset-4">
              {board.title}
            </Link>
          </h2>
          <p className="truncate text-sm text-graphite">
            {isOwner ? `Edited ${timeAgo(board.updatedAt)}` : `Shared by ${board.owner.name}`}
          </p>
        </div>
        {members.length > 1 && <AvatarStack people={members} size="xs" max={3} />}
        <Menu
          trigger={(props) => (
            <button
              type="button"
              aria-label={`Options for ${board.title}`}
              className="-mr-1.5 grid size-8 place-items-center rounded-lg text-graphite transition-colors hover:bg-ink/6 hover:text-ink"
              {...props}
            >
              <Ellipsis className="size-4" aria-hidden />
            </button>
          )}
        >
          <MenuItem icon={ExternalLink} onSelect={() => window.open(`/board/${board.id}`, "_blank", "noopener")}>
            Open in new tab
          </MenuItem>
          <MenuItem icon={PencilLine} onSelect={() => onRename(board)}>
            Rename
          </MenuItem>
          <MenuSeparator />
          {isOwner ? (
            <MenuItem icon={Trash2} tone="danger" onSelect={() => onRemove(board)}>
              Delete
            </MenuItem>
          ) : (
            <MenuItem icon={DoorOpen} tone="danger" onSelect={() => onRemove(board)}>
              Leave board
            </MenuItem>
          )}
        </Menu>
      </div>
    </li>
  );
}

function TileSkeleton() {
  return (
    <li aria-hidden>
      <div className="aspect-[16/10] animate-pulse rounded-lg bg-ink/6" />
      <div className="mt-3 h-4 w-2/3 animate-pulse rounded bg-ink/6" />
      <div className="mt-2 h-3.5 w-1/3 animate-pulse rounded bg-ink/6" />
    </li>
  );
}

function RenameDialog({ board, onClose, onRenamed }) {
  const [title, setTitle] = useState(board?.title ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setTitle(board?.title ?? "");
    setError("");
  }, [board]);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const { board: updated } = await api.renameBoard(board.id, title);
      onRenamed(updated);
      onClose();
    } catch (renameError) {
      setError(renameError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(board)} onClose={onClose} title="Rename board">
      <form onSubmit={submit} className="grid gap-5">
        <TextField
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={80}
          error={error}
          autoFocus
          required
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={!title.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [boards, setBoards] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  useEffect(() => {
    document.title = `Your boards · ${APP_NAME}`;
    let active = true;
    api
      .listBoards()
      .then(({ boards: list }) => active && setBoards(list))
      .catch((error) => active && setLoadError(error.message));
    return () => {
      active = false;
    };
  }, []);

  const visible = useMemo(() => {
    if (!boards) return [];
    const term = query.trim().toLowerCase();
    return boards.filter((board) => {
      if (filter === "mine" && board.role !== "owner") return false;
      if (filter === "shared" && board.role === "owner") return false;
      return !term || board.title.toLowerCase().includes(term);
    });
  }, [boards, filter, query]);

  async function createBoard() {
    setCreating(true);
    try {
      const { board } = await api.createBoard();
      navigate(`/board/${board.id}`);
    } catch (error) {
      toast.error(error.message);
      setCreating(false);
    }
  }

  async function confirmRemove() {
    const board = removing;
    setRemoveBusy(true);
    try {
      if (board.role === "owner") await api.deleteBoard(board.id);
      else await api.removeCollaborator(board.id, "me");
      setBoards((list) => list.filter((item) => item.id !== board.id));
      toast.success(board.role === "owner" ? `Deleted “${board.title}”` : `Left “${board.title}”`);
      setRemoving(null);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setRemoveBusy(false);
    }
  }

  const firstName = user.name.split(" ")[0];

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 pt-10 pb-20 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[2.5rem] leading-none font-extrabold tracking-tight [font-stretch:80%]">Your boards</h1>
            <p className="mt-2 text-graphite">Good to see you, {firstName}.</p>
          </div>
          <Button icon={Plus} onClick={createBoard} loading={creating}>
            New board
          </Button>
        </div>

        {boards?.length > 0 && (
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <div role="tablist" aria-label="Filter boards" className="flex gap-1 rounded-lg bg-ink/5 p-1">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === item.id}
                  onClick={() => setFilter(item.id)}
                  className={clsx(
                    "h-8 rounded-md px-3 text-sm font-medium transition-colors",
                    filter === item.id ? "bg-surface text-ink shadow-sm" : "text-graphite hover:text-ink",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <label className="relative w-full sm:w-64">
              <span className="sr-only">Search boards</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-graphite" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by title"
                className="h-10 w-full rounded-lg border border-rule bg-surface pr-3 pl-9 text-sm transition-colors placeholder:text-graphite/70 focus:border-signal focus:ring-3 focus:ring-signal/20 focus:outline-none"
              />
            </label>
          </div>
        )}

        {loadError && (
          <div role="alert" className="mt-10 rounded-xl border border-danger/30 bg-danger/5 p-6">
            <p className="font-medium text-danger">Your boards couldn't be loaded.</p>
            <p className="mt-1 text-sm text-graphite">{loadError}</p>
            <Button variant="secondary" size="sm" className="mt-4" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        )}

        {!boards && !loadError && (
          <ul className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6 gap-y-8">
            {Array.from({ length: 6 }, (_, index) => (
              <TileSkeleton key={index} />
            ))}
          </ul>
        )}

        {boards?.length === 0 && (
          <div className="graph-paper mt-10 grid place-items-center rounded-xl border border-dashed border-graphite/40 px-6 py-20 text-center">
            <h2 className="text-xl font-bold">No boards yet</h2>
            <p className="mt-2 max-w-sm text-graphite">
              Start a board, then share it by email so others can draw with you.
            </p>
            <Button icon={Plus} onClick={createBoard} loading={creating} className="mt-6">
              Create your first board
            </Button>
          </div>
        )}

        {boards?.length > 0 && visible.length === 0 && (
          <p className="mt-16 text-center text-graphite">
            {query ? `No boards match “${query.trim()}”.` : "No boards here yet."}
          </p>
        )}

        {visible.length > 0 && (
          <ul className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6 gap-y-8">
            {visible.map((board) => (
              <BoardTile key={board.id} board={board} onRename={setRenaming} onRemove={setRemoving} />
            ))}
          </ul>
        )}
      </main>

      <RenameDialog
        board={renaming}
        onClose={() => setRenaming(null)}
        onRenamed={(updated) =>
          setBoards((list) => list.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)))
        }
      />
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={confirmRemove}
        busy={removeBusy}
        title={removing?.role === "owner" ? `Delete “${removing?.title}”?` : `Leave “${removing?.title}”?`}
        description={
          removing?.role === "owner"
            ? "The board and its drawings are deleted for everyone it's shared with. This can't be undone."
            : "You'll lose access until the owner invites you again."
        }
        confirmLabel={removing?.role === "owner" ? "Delete board" : "Leave board"}
      />
    </div>
  );
}
