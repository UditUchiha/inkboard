import clsx from "clsx";
import {
  Check,
  CloudCheck,
  Download,
  Ellipsis,
  Keyboard,
  LayoutGrid,
  LoaderCircle,
  Maximize,
  Minus,
  Monitor,
  Moon,
  Palette,
  Plus,
  Redo2,
  Sun,
  Trash2,
  Undo2,
  UserPlus,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { AvatarStack } from "../../components/Avatar";
import { Button, IconButton } from "../../components/Button";
import { ConfirmDialog } from "../../components/Dialog";
import { LogoMark } from "../../components/Logo";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../../components/Menu";
import { api } from "../../lib/api";
import { useTheme } from "../../providers/ThemeProvider";
import { BoardCanvas } from "./BoardCanvas";
import { DEFAULT_STYLE, DRAWING_TOOLS, TOOLS } from "./constants";
import { duplicate, getSceneBounds, translate } from "./elements";
import { exportBoardAsPng } from "./exportImage";
import { fitViewport, zoomAround } from "./geometry";
import { PropertiesPanel } from "./PropertiesPanel";
import { RemoteCursors } from "./RemoteCursors";
import { ShareDialog } from "./ShareDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { useBoardSnapshot } from "./store";
import { TextEditor } from "./TextEditor";
import { Toolbar } from "./Toolbar";

const isTypingTarget = (target) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

const ARROW_KEYS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

// Tools are reachable by letter (V, P, R…) or by position (1–9).
function toolForKey(key) {
  const byLetter = TOOLS.find((item) => item.key === key);
  if (byLetter) return byLetter;
  return /^[1-9]$/.test(key) ? TOOLS[Number(key) - 1] : null;
}

function styleTarget(tool, selected) {
  if (tool === "select") return selected?.type ?? null;
  return DRAWING_TOOLS.has(tool) ? tool : null;
}

function BoardTitle({ board, onRenamed }) {
  const [title, setTitle] = useState(board.title);
  useEffect(() => setTitle(board.title), [board.title]);

  async function save() {
    const next = title.trim();
    if (!next || next === board.title) {
      setTitle(board.title);
      return;
    }
    try {
      const { board: updated } = await api.renameBoard(board.id, next);
      onRenamed(updated);
    } catch (error) {
      toast.error(error.message);
      setTitle(board.title);
    }
  }

  return (
    <input
      value={title}
      onChange={(event) => setTitle(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setTitle(board.title);
          requestAnimationFrame(() => event.target.blur());
        }
      }}
      maxLength={80}
      aria-label="Board title"
      className="h-10 w-[clamp(7rem,24vw,16rem)] truncate rounded-lg bg-transparent px-2 font-semibold transition-colors hover:bg-ink/5 focus:bg-surface-2 focus:outline-none"
    />
  );
}

function SyncStatus({ online, saving }) {
  let icon = <CloudCheck className="size-4 text-[#2f9e44]" aria-hidden />;
  let label = "Saved";
  if (!online) {
    icon = <WifiOff className="size-4 text-danger" aria-hidden />;
    label = "Reconnecting… changes are kept";
  } else if (saving) {
    icon = <LoaderCircle className="size-4 animate-spin text-graphite" aria-hidden />;
    label = "Saving…";
  }
  return (
    <div role="status" className="floating-panel flex h-10 items-center gap-2 rounded-xl px-3 text-sm text-graphite">
      {icon}
      <span className="max-sm:sr-only">{label}</span>
    </div>
  );
}

export function BoardEditor({ store, sync, user }) {
  const navigate = useNavigate();
  const { preference, setPreference } = useTheme();
  const { elements, canUndo, canRedo } = useBoardSnapshot(store);
  const { meta: board, setMeta } = sync;

  const [tool, setTool] = useState("pen");
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [dialog, setDialog] = useState(null); // "share" | "shortcuts" | "clear"

  const selected = selectedId ? elements.find((element) => element.id === selectedId) : null;

  const changeTool = useCallback((next) => {
    setTool(next);
    if (next !== "select") setSelectedId(null);
  }, []);

  // Fit existing drawings into view once, when the board first opens.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !canvasSize.width) return;
    fitted.current = true;
    const bounds = getSceneBounds(store.getElements());
    if (bounds) setViewport(fitViewport(bounds, canvasSize, { padding: 96, maxZoom: 1 }));
  }, [canvasSize, store]);

  const zoomBy = useCallback(
    (factor) => setViewport((vp) => zoomAround(vp, vp.zoom * factor, canvasSize.width / 2, canvasSize.height / 2)),
    [canvasSize],
  );
  const resetZoom = () => setViewport((vp) => zoomAround(vp, 1, canvasSize.width / 2, canvasSize.height / 2));
  const fitToScreen = useCallback(() => {
    const bounds = getSceneBounds(store.getElements());
    if (bounds) setViewport(fitViewport(bounds, canvasSize, { padding: 96, maxZoom: 2 }));
  }, [store, canvasSize]);

  const deleteSelected = useCallback(() => {
    const element = selectedId && store.getElement(selectedId);
    if (!element) return;
    store.commit({ undo: { upsert: [element] }, redo: { remove: [element.id] } });
    setSelectedId(null);
  }, [selectedId, store]);

  const duplicateSelected = useCallback(() => {
    const element = selectedId && store.getElement(selectedId);
    if (!element) return;
    const copy = duplicate(element);
    store.commit({ undo: { remove: [copy.id] }, redo: { upsert: [copy] } });
    setSelectedId(copy.id);
  }, [selectedId, store]);

  const nudgeSelected = useCallback(
    (dx, dy) => {
      const element = selectedId && store.getElement(selectedId);
      if (!element) return;
      store.commit(
        { undo: { upsert: [element] }, redo: { upsert: [translate(element, dx, dy)] } },
        { mergeKey: `nudge:${element.id}` },
      );
    },
    [selectedId, store],
  );

  useEffect(() => {
    const withModifier = {
      z: (event) => (event.shiftKey ? store.redo() : store.undo()),
      y: () => store.redo(),
      d: duplicateSelected,
      "=": () => zoomBy(1.25),
      "+": () => zoomBy(1.25),
      "-": () => zoomBy(0.8),
      0: resetZoom,
    };
    const plain = {
      " ": () => setSpacePressed(true),
      delete: deleteSelected,
      backspace: deleteSelected,
      escape: () => setSelectedId(null),
      "?": () => setDialog("shortcuts"),
      "!": fitToScreen, // Shift + 1
    };

    function onKeyDown(event) {
      if (isTypingTarget(event.target) || document.querySelector("dialog[open]")) return;
      const key = event.key.toLowerCase();

      if (event.ctrlKey || event.metaKey) {
        if (!withModifier[key]) return;
        event.preventDefault();
        withModifier[key](event);
        return;
      }

      if (plain[key]) {
        if (key === " ") event.preventDefault();
        plain[key]();
      } else if (ARROW_KEYS[event.key] && selectedId) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        nudgeSelected(ARROW_KEYS[event.key][0] * step, ARROW_KEYS[event.key][1] * step);
      } else if (!event.altKey) {
        const next = toolForKey(key);
        if (next) changeTool(next.id);
      }
    }
    const onKeyUp = (event) => event.key === " " && setSpacePressed(false);
    const onBlur = () => setSpacePressed(false);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  });

  function commitText(text) {
    const { element, isNew } = editing;
    setEditing(null);
    const value = text.trimEnd();
    if (isNew) {
      if (!value.trim()) return;
      const created = { ...element, text: value };
      store.commit({ undo: { remove: [created.id] }, redo: { upsert: [created] } });
      return;
    }
    const current = store.getElement(element.id) ?? element;
    if (value === current.text) return;
    if (!value.trim()) {
      store.commit({ undo: { upsert: [current] }, redo: { remove: [current.id] } });
    } else {
      store.commit({ undo: { upsert: [current] }, redo: { upsert: [{ ...current, text: value }] } });
    }
  }

  function changeStyle(key, value) {
    setStyle((current) => ({ ...current, [key]: value }));
    if (selected) {
      store.commit(
        { undo: { upsert: [selected] }, redo: { upsert: [{ ...selected, [key]: value }] } },
        { mergeKey: `style:${selected.id}:${key}` },
      );
    }
  }

  async function exportPng() {
    const done = await exportBoardAsPng(store.getElements(), board.title);
    if (!done) toast("Draw something first. There's nothing to export yet.");
  }

  function clearBoard() {
    const all = store.getElements();
    store.commit({ undo: { upsert: all }, redo: { remove: all.map((element) => element.id) } });
    setSelectedId(null);
    setDialog(null);
    toast("Board cleared", { action: { label: "Undo", onClick: () => store.undo() } });
  }

  const panelType = styleTarget(tool, selected);
  const others = useMemo(() => {
    const seen = new Map();
    for (const peer of sync.peers) {
      if (peer.userId !== user.id && !seen.has(peer.userId)) {
        seen.set(peer.userId, { id: peer.userId, name: peer.name, title: `${peer.name} is here` });
      }
    }
    return [...seen.values()];
  }, [sync.peers, user.id]);

  return (
    <div className="fixed inset-0 overflow-hidden select-none">
      <BoardCanvas
        store={store}
        tool={tool}
        style={style}
        viewport={viewport}
        onViewportChange={setViewport}
        selectedId={selectedId}
        onSelect={setSelectedId}
        editingId={editing?.element.id}
        onEditText={setEditing}
        spacePressed={spacePressed}
        onCursorMove={sync.sendCursor}
        onSizeChange={setCanvasSize}
      />

      <RemoteCursors cursors={sync.cursors} peers={sync.peers} viewport={viewport} />

      {editing && (
        <TextEditor key={editing.element.id} element={editing.element} viewport={viewport} onCommit={commitText} />
      )}

      {/* Top left: back to boards, title */}
      <div className="floating-panel absolute top-3 left-3 flex items-center gap-0.5 rounded-xl p-1">
        <Link
          to="/boards"
          title="All boards"
          aria-label="All boards"
          className="grid size-10 place-items-center rounded-lg transition-colors hover:bg-ink/6"
        >
          <LogoMark className="size-6" />
        </Link>
        <BoardTitle board={board} onRenamed={(updated) => setMeta((current) => ({ ...current, ...updated }))} />
      </div>

      {/* Tools: top centre on wide screens, bottom on phones */}
      <div className="absolute inset-x-3 bottom-3 flex justify-center md:inset-x-auto md:top-3 md:bottom-auto md:left-1/2 md:-translate-x-1/2">
        <Toolbar tool={tool} onToolChange={changeTool} className="max-md:max-w-full max-md:overflow-x-auto" />
      </div>

      {/* Top right: people, share, menu */}
      <div className="absolute top-3 right-3 flex items-center gap-2">
        {others.length > 0 && (
          <div className="max-sm:hidden">
            <AvatarStack people={others} size="sm" />
          </div>
        )}
        <Button icon={UserPlus} onClick={() => setDialog("share")} className="max-sm:px-3">
          <span className="max-sm:sr-only">Share</span>
        </Button>
        <Menu
          trigger={(props) => (
            <IconButton label="Board menu" icon={Ellipsis} className="floating-panel rounded-xl" {...props} />
          )}
        >
          <MenuItem icon={Download} onSelect={exportPng}>
            Export as PNG
          </MenuItem>
          <MenuItem icon={Keyboard} hint="?" onSelect={() => setDialog("shortcuts")}>
            Keyboard shortcuts
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Theme</MenuLabel>
          {[
            ["light", "Light", Sun],
            ["dark", "Dark", Moon],
            ["system", "Match system", Monitor],
          ].map(([value, label, Icon]) => (
            <MenuItem key={value} icon={Icon} onSelect={() => setPreference(value)} hint={preference === value ? <Check className="size-4" /> : null}>
              {label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={Trash2} tone="danger" onSelect={() => setDialog("clear")} disabled={elements.length === 0}>
            Clear board
          </MenuItem>
          <MenuItem icon={LayoutGrid} onSelect={() => navigate("/boards")}>
            All boards
          </MenuItem>
        </Menu>
      </div>

      {/* Style panel */}
      {panelType && (
        <div
          className={clsx(
            "absolute left-3 max-md:bottom-[7.5rem] md:top-20",
            !panelOpen && "max-md:hidden",
          )}
        >
          <PropertiesPanel
            type={panelType}
            values={selected ?? style}
            onChange={changeStyle}
            selection={Boolean(selected && tool === "select")}
            onDuplicate={duplicateSelected}
            onDelete={deleteSelected}
          />
        </div>
      )}

      {/* View controls */}
      <div className="absolute bottom-[4.25rem] left-3 flex items-center gap-2 md:bottom-3">
        <div className="floating-panel flex items-center rounded-xl p-1">
          <IconButton label="Undo" icon={Undo2} onClick={store.undo} disabled={!canUndo} />
          <IconButton label="Redo" icon={Redo2} onClick={store.redo} disabled={!canRedo} />
        </div>
        <div className="floating-panel flex items-center rounded-xl p-1 max-sm:hidden">
          <IconButton label="Zoom out" icon={Minus} onClick={() => zoomBy(0.8)} />
          <button
            type="button"
            onClick={resetZoom}
            title="Reset zoom"
            className="h-10 min-w-14 rounded-lg px-1 text-sm font-medium tabular-nums transition-colors hover:bg-ink/6"
          >
            {Math.round(viewport.zoom * 100)}%
          </button>
          <IconButton label="Zoom in" icon={Plus} onClick={() => zoomBy(1.25)} />
          <IconButton label="Fit drawing to screen" icon={Maximize} onClick={fitToScreen} disabled={elements.length === 0} />
        </div>
        {panelType && (
          <div className="floating-panel rounded-xl p-1 md:hidden">
            <IconButton label="Style" icon={Palette} active={panelOpen} onClick={() => setPanelOpen((open) => !open)} />
          </div>
        )}
      </div>

      <div className="absolute right-3 bottom-[4.25rem] flex items-center gap-2 md:bottom-3">
        <SyncStatus online={sync.online} saving={sync.saving} />
        <div className="floating-panel rounded-xl p-1 max-md:hidden">
          <IconButton label="Keyboard shortcuts" icon={Keyboard} onClick={() => setDialog("shortcuts")} />
        </div>
      </div>

      <ShareDialog
        open={dialog === "share"}
        onClose={() => setDialog(null)}
        board={board}
        currentUser={user}
        onBoardChange={(updated) => setMeta((current) => ({ ...current, ...updated }))}
        onLeft={() => {
          toast(`You left “${board.title}”`);
          navigate("/boards");
        }}
      />
      <ShortcutsDialog open={dialog === "shortcuts"} onClose={() => setDialog(null)} />
      <ConfirmDialog
        open={dialog === "clear"}
        onClose={() => setDialog(null)}
        onConfirm={clearBoard}
        title="Clear the whole board?"
        description="This removes every drawing for everyone on the board. You can undo it right after."
        confirmLabel="Clear board"
      />
    </div>
  );
}
