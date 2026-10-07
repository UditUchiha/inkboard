import clsx from "clsx";
import {
  Check,
  CloudCheck,
  Download,
  Ellipsis,
  Eye,
  History,
  Keyboard,
  LayoutGrid,
  LayoutTemplate,
  LoaderCircle,
  Maximize,
  MessageSquare,
  Minus,
  Monitor,
  Moon,
  Palette,
  Plus,
  Redo2,
  Save,
  Sun,
  Trash2,
  Undo2,
  UserPlus,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { Button, ButtonLink, IconButton } from "../../components/Button";
import { ConfirmDialog } from "../../components/Dialog";
import { LogoMark } from "../../components/Logo";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../../components/Menu";
import { api } from "../../lib/api";
import { getGuest } from "../../lib/guest";
import { useTheme } from "../../providers/ThemeProvider";
import { BoardCanvas } from "./BoardCanvas";
import { CommentsLayer } from "./CommentsLayer";
import { COMMENT_TOOL, DEFAULT_STYLE, DRAWING_TOOLS, TOOLS } from "./constants";
import { createImage, duplicate, getSceneBounds, translate } from "./elements";
import { exportBoardAsPng } from "./exportImage";
import { fitViewport, toWorld, zoomAround } from "./geometry";
import { GuestIdentity } from "./GuestIdentity";
import { ImageError, isImageFile, placementSize, prepareImage, primeImage, uploadImage } from "./images";
import { PresenceStack } from "./PresenceStack";
import { PropertiesPanel } from "./PropertiesPanel";
import { RemoteCursors } from "./RemoteCursors";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
import { ShareDialog } from "./ShareDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { useBoardSnapshot } from "./store";
import { TextEditor } from "./TextEditor";
import { Toolbar } from "./Toolbar";
import { useFollow } from "./useFollow";
import { useThreads } from "./useThreads";
import { VersionHistory } from "./VersionHistory";

const isTypingTarget = (target) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

const ARROW_KEYS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

// Tools are reachable by letter (V, P, R…) or by position (1–9). Comments have a letter only.
function toolForKey(key, withComments) {
  const byLetter = (withComments ? [...TOOLS, COMMENT_TOOL] : TOOLS).find((item) => item.key === key);
  if (byLetter) return byLetter;
  return /^[1-9]$/.test(key) ? TOOLS[Number(key) - 1] : null;
}

function styleTarget(tool, selected) {
  if (tool === "select") return selected?.type ?? null;
  return DRAWING_TOOLS.has(tool) ? tool : null;
}

function BoardTitle({ board, rename, onRenamed, readOnly }) {
  const [title, setTitle] = useState(board.title);
  useEffect(() => setTitle(board.title), [board.title]);

  if (readOnly) {
    return <h1 className="max-w-[clamp(7rem,24vw,16rem)] truncate px-2 font-semibold">{board.title}</h1>;
  }

  async function save() {
    const next = title.trim();
    if (!next || next === board.title) {
      setTitle(board.title);
      return;
    }
    try {
      onRenamed(await rename(next));
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

function ViewOnlyNotice({ signedIn, loginHref }) {
  return (
    <div className="floating-panel flex h-12 items-center gap-3 rounded-xl pr-2 pl-4 text-sm">
      <Eye className="size-4 shrink-0 text-graphite" aria-hidden />
      <span className="font-medium">View only</span>
      <span className="text-graphite max-lg:hidden">
        {signedIn ? "Ask the owner to invite you to edit" : "Log in if you've been invited to edit"}
      </span>
      {!signedIn && (
        <ButtonLink to={loginHref} size="sm">
          Log in
        </ButtonLink>
      )}
    </div>
  );
}

function SyncStatus({ online, saving, readOnly, local }) {
  let icon = <CloudCheck className="size-4 text-[#2f9e44]" aria-hidden />;
  let label = readOnly ? "Up to date" : "Saved";
  if (local) {
    label = "Saved on this device";
  } else if (!online) {
    icon = <WifiOff className="size-4 text-danger" aria-hidden />;
    label = readOnly ? "Reconnecting…" : "Reconnecting… changes are kept";
  } else if (saving && !readOnly) {
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

/**
 * The whiteboard. `user` is null for guests. `local` is set for a guest's own
 * scratch board, which lives in the browser: there's no server, so sharing,
 * history and comments give way to a "Save board" button ({ onSave }).
 */
export function BoardEditor({ store, sync, user, local = null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { preference, setPreference } = useTheme();
  const { elements, canUndo, canRedo } = useBoardSnapshot(store);
  const { meta: board, setMeta, role } = sync;
  const readOnly = role === "viewer"; // viewers can only look; contributors (edit link) can draw
  const isMember = role === "owner" || role === "editor";
  const commentsEnabled = Boolean(user) && !local; // comments are for signed-in people
  const canComment = commentsEnabled && !readOnly;
  const selfId = user?.id ?? getGuest().id;

  const [tool, setTool] = useState("pen");
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [dialog, setDialog] = useState(null); // "share" | "shortcuts" | "clear" | "template"
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [activeThread, setActiveThread] = useState(null);
  const [draft, setDraft] = useState(null); // where a new comment is being written

  const selected = selectedId ? elements.find((element) => element.id === selectedId) : null;
  const canAddImages = !readOnly && !local; // a guest's scratch board lives in the browser, with nowhere to keep files
  const fileInput = useRef(null);

  // Follow mode: tracking someone's view until we move ourselves.
  const { followingId, follow, stopFollowing } = useFollow({ sync, canvasSize, setViewport });
  const changeViewport = useCallback(
    (next) => {
      stopFollowing();
      setViewport(next);
    },
    [stopFollowing],
  );

  // Share what we're looking at, so others can follow us.
  const { sendViewport } = sync;
  useEffect(() => {
    if (canvasSize.width) sendViewport({ ...viewport, width: canvasSize.width, height: canvasSize.height });
  }, [viewport, canvasSize, sendViewport]);

  const { threads, ...threadApi } = useThreads({ boardId: board.id, socket: sync.socket, enabled: commentsEnabled });
  const members = useMemo(
    () => [board.owner, ...board.collaborators].filter((person) => person && person.id !== selfId),
    [board.owner, board.collaborators, selfId],
  );

  // A notification links to ?thread=…: open that comment and bring it into view, once.
  const openedThread = useRef(null);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("thread");
    const thread = id && threads.find((item) => item.id === id);
    if (!thread || openedThread.current === id || !canvasSize.width) return;
    openedThread.current = id;
    setShowComments(true);
    setActiveThread(id);
    setViewport((vp) => ({
      ...vp,
      x: canvasSize.width / 2 / vp.zoom - thread.x,
      y: canvasSize.height / 2 / vp.zoom - thread.y,
    }));
  }, [threads, location.search, canvasSize]);

  // The comment tool disappears if we lose the right to comment.
  useEffect(() => {
    if (!canComment && tool === "comment") setTool("pen");
  }, [canComment, tool]);

  const placeComment = useCallback((point) => {
    setActiveThread(null);
    setDraft(point);
  }, []);

  const renameBoard = useCallback(
    async (title) => (local ? { title } : (await api.renameBoard(board.id, title)).board),
    [local, board.id],
  );

  // Access can be lowered while the board is open: drop anything half-done.
  useEffect(() => {
    if (!readOnly) return;
    setSelectedId(null);
    setEditing(null);
    setDialog((current) => (current === "clear" ? null : current));
  }, [readOnly]);

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
    (factor) => changeViewport((vp) => zoomAround(vp, vp.zoom * factor, canvasSize.width / 2, canvasSize.height / 2)),
    [canvasSize, changeViewport],
  );
  const resetZoom = () => changeViewport((vp) => zoomAround(vp, 1, canvasSize.width / 2, canvasSize.height / 2));
  const fitToScreen = useCallback(() => {
    const bounds = getSceneBounds(store.getElements());
    if (bounds) changeViewport(fitViewport(bounds, canvasSize, { padding: 96, maxZoom: 2 }));
  }, [store, canvasSize, changeViewport]);

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

  // Adds pictures to the board: shrinks and uploads each, then places it where it
  // was dropped, or in the middle of the screen. Each one is a single undo step.
  const view = useRef(null);
  view.current = { viewport, canvasSize };
  const addImages = useCallback(
    async (files, dropPoint = null) => {
      if (local) {
        toast("Save this board to your account to add images.");
        return;
      }
      for (const [index, file] of files.slice(0, 10).entries()) {
        const progress = toast.loading(files.length > 1 ? `Adding image ${index + 1} of ${files.length}…` : "Adding image…");
        try {
          const picked = await prepareImage(file);
          const id = await uploadImage(sync.socket, board.id, picked.blob);
          primeImage(id, picked.blob);

          const { viewport: vp, canvasSize: size } = view.current;
          const area = { width: size.width / vp.zoom, height: size.height / vp.zoom };
          const middle = dropPoint ?? { x: -vp.x + area.width / 2, y: -vp.y + area.height / 2 };
          const shift = index * 24; // keep several pictures from landing exactly on top of each other
          const fitted = placementSize(picked, area);
          const element = createImage(
            id,
            { x: middle.x - fitted.width / 2 + shift, y: middle.y - fitted.height / 2 + shift },
            fitted,
          );
          store.commit({ undo: { remove: [element.id] }, redo: { upsert: [element] } });
          setTool("select");
          setSelectedId(element.id);
          toast.dismiss(progress);
        } catch (error) {
          toast.error(error instanceof ImageError ? error.message : "That image couldn't be added.", { id: progress });
        }
      }
    },
    [local, sync.socket, board.id, store],
  );

  // Pictures can be pasted or dropped onto the board.
  const addImagesRef = useRef(addImages);
  addImagesRef.current = addImages;
  useEffect(() => {
    const imagesIn = (list) => [...(list ?? [])].filter(isImageFile);
    const blocked = (event) => isTypingTarget(event.target) || document.querySelector("dialog[open]");

    const onPaste = (event) => {
      const files = imagesIn(event.clipboardData?.files);
      if (readOnly || files.length === 0 || blocked(event)) return;
      event.preventDefault();
      addImagesRef.current(files);
    };
    const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
    const onDragOver = (event) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const onDrop = (event) => {
      if (!carriesFiles(event)) return;
      // Left alone, the browser opens a dropped file in the tab, leaving the board,
      // so this happens even for people who can only view it.
      event.preventDefault();
      const files = imagesIn(event.dataTransfer.files);
      if (readOnly || blocked(event)) return;
      if (files.length === 0) {
        toast.error("Only PNG, JPEG, WebP and GIF images can be added.");
        return;
      }
      const { viewport: vp } = view.current;
      addImagesRef.current(files, toWorld(vp, event.clientX, event.clientY));
    };

    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [readOnly]);

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
      escape: () => {
        setSelectedId(null);
        setDraft(null);
        setActiveThread(null);
        stopFollowing();
      },
      i: () => canAddImages && fileInput.current?.click(),
      "?": () => setDialog("shortcuts"),
      "!": fitToScreen, // Shift + 1
    };

    if (readOnly) {
      for (const key of ["z", "y", "d"]) delete withModifier[key];
      for (const key of ["delete", "backspace"]) delete plain[key];
    }

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
      } else if (ARROW_KEYS[event.key] && selectedId && !readOnly) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        nudgeSelected(ARROW_KEYS[event.key][0] * step, ARROW_KEYS[event.key][1] * step);
      } else if (!event.altKey && !readOnly) {
        const next = toolForKey(key, canComment);
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

  const panelType = readOnly ? null : styleTarget(tool, selected);
  const others = useMemo(() => {
    const seen = new Map();
    for (const peer of sync.peers) {
      if (peer.userId !== selfId && !seen.has(peer.userId)) seen.set(peer.userId, peer);
    }
    return [...seen.values()];
  }, [sync.peers, selfId]);

  const followed = others.find((person) => person.socketId === followingId);

  async function saveCurrentAsTemplate(title) {
    await api.saveTemplate(board.id, title);
    toast.success("Template saved. Find it when you start a new board.");
  }

  return (
    <div className="fixed inset-0 overflow-hidden select-none">
      <BoardCanvas
        store={store}
        tool={readOnly ? "hand" : tool}
        style={style}
        viewport={viewport}
        onViewportChange={changeViewport}
        selectedId={selectedId}
        onSelect={setSelectedId}
        editingId={editing?.element.id}
        onEditText={setEditing}
        spacePressed={spacePressed}
        onCursorMove={sync.sendCursor}
        onSizeChange={setCanvasSize}
        onPlaceComment={placeComment}
      />

      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(event) => {
          addImages([...event.target.files]);
          event.target.value = "";
        }}
      />

      <RemoteCursors cursors={sync.cursors} peers={sync.peers} viewport={viewport} />

      {commentsEnabled && showComments && (
        <CommentsLayer
          threads={threads}
          viewport={viewport}
          size={canvasSize}
          activeId={activeThread}
          onActive={(id) => {
            setDraft(null);
            setActiveThread(id);
          }}
          draft={draft}
          onDraftClose={() => setDraft(null)}
          members={members}
          canComment={canComment}
          canDeleteAny={role === "owner"}
          selfId={selfId}
          api={threadApi}
        />
      )}

      {editing && (
        <TextEditor key={editing.element.id} element={editing.element} viewport={viewport} onCommit={commitText} />
      )}

      {/* Top left: back to boards, title */}
      <div className="floating-panel absolute top-3 left-3 flex items-center gap-0.5 rounded-xl p-1">
        <Link
          to={user ? "/boards" : "/"}
          title={user ? "All boards" : "Home"}
          aria-label={user ? "All boards" : "Home"}
          className="grid size-10 place-items-center rounded-lg transition-colors hover:bg-ink/6"
        >
          <LogoMark className="size-6" />
        </Link>
        <BoardTitle
          board={board}
          rename={renameBoard}
          readOnly={readOnly}
          onRenamed={(updated) => setMeta((current) => ({ ...current, ...updated }))}
        />
      </div>

      {/* Tools: top centre on wide screens, bottom on phones. Viewers get a notice instead. */}
      <div className="absolute inset-x-3 bottom-3 flex justify-center md:inset-x-auto md:top-3 md:bottom-auto md:left-1/2 md:-translate-x-1/2">
        {readOnly ? (
          <ViewOnlyNotice
            signedIn={Boolean(user)}
            loginHref={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
          />
        ) : (
          <Toolbar
            tool={tool}
            onToolChange={changeTool}
            onAddImage={canAddImages ? () => fileInput.current?.click() : undefined}
            withComments={canComment}
            className="max-md:max-w-full max-md:overflow-x-auto"
          />
        )}
      </div>

      {/* Top right: people, share, menu */}
      <div className="absolute top-3 right-3 flex items-center gap-2">
        {others.length > 0 && (
          <div className="max-sm:hidden">
            <PresenceStack people={others} followingId={followingId} onFollow={follow} />
          </div>
        )}
        {!user && !local && <GuestIdentity socket={sync.socket} />}
        {local ? (
          <Button icon={Save} onClick={local.onSave} className="max-sm:px-3">
            <span className="max-sm:sr-only">Save board</span>
          </Button>
        ) : (
          <Button icon={UserPlus} onClick={() => setDialog("share")} className="max-sm:px-3">
            <span className="max-sm:sr-only">Share</span>
          </Button>
        )}
        <Menu
          trigger={(props) => (
            <IconButton label="Board menu" icon={Ellipsis} className="floating-panel rounded-xl" {...props} />
          )}
        >
          <MenuItem icon={Download} onSelect={exportPng}>
            Export as PNG
          </MenuItem>
          {isMember && !local && (
            <>
              <MenuItem icon={History} onSelect={() => setHistoryOpen(true)}>
                Version history
              </MenuItem>
              <MenuItem icon={LayoutTemplate} onSelect={() => setDialog("template")} disabled={elements.length === 0}>
                Save as template
              </MenuItem>
            </>
          )}
          {commentsEnabled && (
            <MenuItem
              icon={MessageSquare}
              onSelect={() => setShowComments((shown) => !shown)}
              hint={showComments ? <Check className="size-4" /> : null}
            >
              Show comments
            </MenuItem>
          )}
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
          {/* Wiping a whole board is for its members (or the guest who owns a scratch board), not link visitors. */}
          {(isMember || local) && (
            <MenuItem icon={Trash2} tone="danger" onSelect={() => setDialog("clear")} disabled={elements.length === 0}>
              Clear board
            </MenuItem>
          )}
          {user && (
            <MenuItem icon={LayoutGrid} onSelect={() => navigate("/boards")}>
              All boards
            </MenuItem>
          )}
        </Menu>
      </div>

      {followed && (
        <div className="absolute top-[4.25rem] left-1/2 -translate-x-1/2 max-md:top-16">
          <button
            type="button"
            onClick={stopFollowing}
            className="floating-panel flex h-9 items-center gap-2 rounded-full pr-2 pl-4 text-sm transition-colors hover:bg-surface-2"
          >
            Following <strong className="font-semibold">{followed.name}</strong>
            <span className="grid size-5 place-items-center rounded-full bg-ink/8" aria-hidden>
              <X className="size-3" />
            </span>
            <span className="sr-only">Stop following</span>
          </button>
        </div>
      )}

      {historyOpen && isMember && <VersionHistory boardId={board.id} onClose={() => setHistoryOpen(false)} />}

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
        {!readOnly && (
          <div className="floating-panel flex items-center rounded-xl p-1">
            <IconButton label="Undo" icon={Undo2} onClick={store.undo} disabled={!canUndo} />
            <IconButton label="Redo" icon={Redo2} onClick={store.redo} disabled={!canRedo} />
          </div>
        )}
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
        <SyncStatus online={sync.online} saving={sync.saving} readOnly={readOnly} local={Boolean(local)} />
        <div className="floating-panel rounded-xl p-1 max-md:hidden">
          <IconButton label="Keyboard shortcuts" icon={Keyboard} onClick={() => setDialog("shortcuts")} />
        </div>
      </div>

      <SaveTemplateDialog
        open={dialog === "template"}
        onClose={() => setDialog(null)}
        defaultTitle={board.title}
        onSave={saveCurrentAsTemplate}
      />
      {!local && (
      <ShareDialog
        open={dialog === "share"}
        onClose={() => setDialog(null)}
        board={board}
        role={role}
        currentUser={user}
        onBoardChange={(updated) => setMeta((current) => ({ ...current, ...updated }))}
        onLeft={() => {
          toast(`You left “${board.title}”`);
          navigate("/boards");
        }}
      />
      )}
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
