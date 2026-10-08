import clsx from "clsx";
import { Bookmark, History, LoaderCircle, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "../../components/Avatar";
import { Button, IconButton } from "../../components/Button";
import { api } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { BoardPreview } from "./BoardPreview";

const KIND_LABELS = {
  auto: "Autosaved",
  named: "Saved version",
  restore: "Before a restore",
};

function VersionRow({ version, selected, onSelect }) {
  const title = version.label || KIND_LABELS[version.kind];
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={clsx(
          "flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
          selected ? "bg-signal/10" : "hover:bg-ink/6",
        )}
      >
        {version.kind === "named" ? (
          <Bookmark className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
        ) : (
          <History className="mt-0.5 size-4 shrink-0 text-graphite" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="block text-xs text-graphite">
            {timeAgo(version.createdAt)} · {version.elementCount} {version.elementCount === 1 ? "element" : "elements"}
            {version.author && ` · ${version.author.name}`}
          </span>
        </span>
      </button>
    </li>
  );
}

function Preview({ boardId, version, onRestored, onDeleted }) {
  const [elements, setElements] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null); // "restore" | "delete"

  useEffect(() => {
    setElements(null);
    setConfirming(null);
    let active = true;
    api
      .getVersion(boardId, version.id)
      .then(({ version: full }) => active && setElements(full.elements))
      .catch((error) => active && toast.error(error.message));
    return () => {
      active = false;
    };
  }, [boardId, version.id]);

  async function restore() {
    setBusy(true);
    try {
      await api.restoreVersion(boardId, version.id);
      toast.success("Version restored. What was here before is saved in the history.");
      onRestored();
    } catch (error) {
      toast.error(error.message);
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteVersion(boardId, version.id);
      toast.success("Version deleted");
      onDeleted();
    } catch (error) {
      toast.error(error.message);
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-rule p-3">
      <div className="graph-paper overflow-hidden rounded-lg border border-rule [--cell:14px]">
        {elements ? (
          <BoardPreview elements={elements} className="aspect-[16/10]" padding={12}>
            {elements.length === 0 && (
              <span className="absolute inset-0 grid place-items-center text-sm text-graphite">Empty board</span>
            )}
          </BoardPreview>
        ) : (
          <div className="grid aspect-[16/10] place-items-center text-graphite">
            <LoaderCircle className="size-5 animate-spin" aria-hidden />
          </div>
        )}
      </div>
      {confirming ? (
        <div className="mt-3 rounded-lg bg-surface-2 p-3">
          <p className="text-sm">
            {confirming === "restore"
              ? "Everyone on the board will see this version. The current board is saved in the history first, so you can come back to it."
              : `Delete “${version.label}” from the history for everyone? This can't be undone.`}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            {confirming === "restore" ? (
              <Button size="sm" loading={busy} onClick={restore}>
                Restore
              </Button>
            ) : (
              <Button variant="danger" size="sm" loading={busy} onClick={remove}>
                Delete
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            icon={RotateCcw}
            disabled={!elements}
            onClick={() => setConfirming("restore")}
          >
            Restore this version
          </Button>
          {/* Saved versions are kept until someone deletes them; autosaves clear on their own. */}
          {version.kind === "named" && (
            <IconButton label="Delete this version" icon={Trash2} onClick={() => setConfirming("delete")} />
          )}
        </div>
      )}
    </div>
  );
}

/** A side panel listing a board's saved versions, with previews and restore. For members only. */
export function VersionHistory({ boardId, onClose }) {
  const [versions, setVersions] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const { versions: list } = await api.listVersions(boardId);
      setVersions(list);
    } catch (error) {
      toast.error(error.message);
      setVersions([]);
    }
  }, [boardId]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveVersion(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const { version } = await api.saveVersion(boardId, label);
      setVersions((list) => [version, ...(list ?? [])]);
      setSelectedId(version.id);
      setLabel("");
      toast.success("Version saved");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  const selected = versions?.find((version) => version.id === selectedId);

  return (
    <aside
      aria-label="Version history"
      className="floating-panel absolute top-16 right-3 bottom-[4.25rem] z-20 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col rounded-xl md:bottom-16"
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h2 className="font-semibold">Version history</h2>
        <IconButton label="Close version history" icon={X} size="sm" onClick={onClose} />
      </div>

      <form onSubmit={saveVersion} className="flex gap-2 px-4 pb-3">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Name the board as it is now"
          maxLength={60}
          aria-label="Version name"
          className="h-9 min-w-0 flex-1 rounded-lg border border-rule bg-surface px-3 text-sm placeholder:text-graphite/70 focus:border-signal focus:ring-3 focus:ring-signal/20 focus:outline-none"
        />
        <Button type="submit" size="sm" className="h-9" loading={saving} disabled={!label.trim()}>
          Save
        </Button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-rule px-1.5 py-1.5">
        {!versions && (
          <p className="flex items-center gap-2 px-2.5 py-3 text-sm text-graphite">
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading
          </p>
        )}
        {versions?.length === 0 && (
          <p className="px-2.5 py-3 text-sm text-graphite">
            No versions yet. The board is saved automatically as people draw, and you can save a named version any time.
          </p>
        )}
        {versions?.length > 0 && (
          <ul>
            {versions.map((version) => (
              <VersionRow
                key={version.id}
                version={version}
                selected={version.id === selectedId}
                onSelect={() => setSelectedId(version.id === selectedId ? null : version.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <Preview
          boardId={boardId}
          version={selected}
          onRestored={() => {
            setSelectedId(null);
            load();
          }}
          onDeleted={() => {
            setSelectedId(null);
            setVersions((list) => list.filter((version) => version.id !== selected.id));
          }}
        />
      )}
    </aside>
  );
}
