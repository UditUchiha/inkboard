import clsx from "clsx";
import { Link, useLocation, useNavigate } from "react-router";
import { Keyboard, MessageSquarePlus, Save, UserPlus, X } from "lucide-react";
import { STACK_MOVES } from "@inkboard/shared/board-order";
import { MAX_TEXT_LENGTH } from "@inkboard/shared/element-rules";
import type {
  Element as BoardElement,
  ElementType,
  StackMove,
  StickyElement,
  TextElement,
} from "@inkboard/shared/types";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, IconButton } from "../../components/Button";
import { ConfirmDialog } from "../../components/Dialog";
import { BoardCrashed, ErrorBoundary } from "../../components/ErrorBoundary";
import { LogoMark } from "../../components/Logo";
import { api, errorMessage } from "../../lib/api";
import type { AccountUser, BoardMeta } from "../../lib/api";
import { getGuest } from "../../lib/guest";
import { BoardCanvas } from "./BoardCanvas";
import type { TextEdit } from "./BoardCanvas";
import { BoardMenu } from "./BoardMenu";
import type { Exporter } from "./BoardMenu";
import { BoardTitle } from "./BoardTitle";
import type { RenamedBoard } from "./BoardTitle";
import { CommentsLayer } from "./CommentsLayer";
import { DEFAULT_STYLE, DRAWING_TOOLS } from "./constants";
import type { ToolId } from "./constants";
import { copyGroup, drawnElement, isConnector, moveGroup } from "./connectors";
import { ElementList } from "./ElementList";
import { describeElement } from "./elementLabels";
import { getBounds, getSceneBounds, isFrame, stackKey, withContents } from "./elements";
import type { Connector } from "./elements";
import { ExportError } from "./exportSize";
import { fitViewport, zoomAround } from "./geometry";
import type { Rect, Viewport, XY } from "./geometry";
import { GuestIdentity } from "./GuestIdentity";
import { copyOffset, viewToReveal } from "./placement";
import { PresenceStack } from "./PresenceStack";
import { PropertiesPanel } from "./PropertiesPanel";
import type { StyleChange } from "./PropertiesPanel";
import { RemoteCursors } from "./RemoteCursors";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
import { ShareDialog } from "./ShareDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { SuggestingNotice, SyncStatus, ViewOnlyNotice } from "./StatusPanels";
import { connectorPath, pathMiddle } from "./routes";
import { useBoardSnapshot } from "./store";
import type { BoardStore } from "./store";
import { suggestionMarks } from "./suggestions";
import type { OwnSuggestions, SuggestionGroup } from "./suggestions";
import { idsInGroup, SuggestionChips, SuggestionsPanel, useSuggestionReview } from "./SuggestionsPanel";
import { LabelEditor, NoteEditor, TextEditor } from "./TextEditor";
import { Toolbar } from "./Toolbar";
import { useBoardShortcuts } from "./useBoardShortcuts";
import { drawsOnBoard } from "./useBoardSync";
import type { BoardSync, Peer } from "./useBoardSync";
import { sameView, useFollow } from "./useFollow";
import { useImageImport } from "./useImageImport";
import type { ImportView } from "./useImageImport";
import { useThreads } from "./useThreads";
import { VersionHistory } from "./VersionHistory";
import { ViewControls } from "./ViewControls";

// The canvas only redraws when its own props change, not for every pointer or cursor message elsewhere.
const MemoBoardCanvas = memo(BoardCanvas);

const FRAME_COPY_GAP = 80;

// The elements that carry text, which are the ones edited in place.
type TextBearing = TextElement | StickyElement | Connector;

// The cast: DRAWING_TOOLS holds only tools that are also the type of the element they draw.
function styleTarget(tool: ToolId, selected: BoardElement | null): ElementType | null {
  if (tool === "select") return selected?.type ?? null;
  return DRAWING_TOOLS.has(tool) ? (tool as ElementType) : null;
}

/** What the editor takes: the store and sync (a scratch board's has `unsaved` too), who is looking, and `local`. */
export type BoardEditorProps = {
  store: BoardStore;
  sync: BoardSync & { unsaved?: boolean };
  user: AccountUser | null;
  local?: { onSave: () => void } | null;
};

/**
 * The whiteboard. `user` is null for guests. `local` is set for a guest's own
 * scratch board, which lives in the browser: there's no server, so sharing,
 * history and comments give way to a "Save board" button ({ onSave }).
 */
export function BoardEditor({ store, sync, user, local = null }: BoardEditorProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { elements, canUndo, canRedo } = useBoardSnapshot(store);
  // The cast: the editor is only shown once the board's details are there (a scratch board has them from the start).
  const { meta: board, setMeta, role } = sync as BoardSync & { meta: BoardMeta };
  // Viewers can only look, and contributors (edit link) can draw. Suggesters draw too, but what they do is sent as
  // suggestions (see suggesting.ts), so the board's own settings (its title, pictures, comments) aren't theirs to change.
  const readOnly = role === "viewer";
  const suggesting = role === "suggester";
  const isMember = role === "owner" || role === "editor";
  // Comments are for signed-in people, and all of them can comment, viewers and suggesters too.
  const commentsEnabled = Boolean(user) && !local;
  const canComment = commentsEnabled;
  const selfId = user?.id ?? getGuest().id;

  const [tool, setTool] = useState<ToolId>("pen");
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TextEdit | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [dialog, setDialog] = useState<"share" | "shortcuts" | "clear" | "template" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [draft, setDraft] = useState<XY | null>(null); // where a new comment is being written
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  // A notification about suggestions links to ?suggestions, which opens them (also when the board is open already).
  const linkedSuggestions = new URLSearchParams(location.search).has("suggestions");
  useEffect(() => {
    if (linkedSuggestions) setSuggestionsOpen(true);
  }, [linkedSuggestions, location.key]);
  // A request for access links its owner to ?invite=<email>, which opens the Share dialog with the address filled in.
  const linkedInvite = new URLSearchParams(location.search).get("invite");
  useEffect(() => {
    if (linkedInvite !== null && role === "owner") setDialog("share");
  }, [linkedInvite, role, location.key]);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);

  const selected = selectedId ? (store.getElement(selectedId) ?? null) : null;
  // A guest's scratch board lives in the browser, with nowhere to keep files; pictures can't be suggested.
  const canAddImages = !readOnly && !local && !suggesting;
  const fileInput = useRef<HTMLInputElement>(null);
  const boardFileInput = useRef<HTMLInputElement>(null);

  // Follow mode: tracking someone's view until we move ourselves.
  const { followingId, follow, stopFollowing, followedView } = useFollow({ sync, canvasSize, setViewport });
  const changeViewport = useCallback(
    (next: Viewport | ((current: Viewport) => Viewport)) => {
      stopFollowing();
      setViewport(next);
    },
    [stopFollowing],
  );

  // Share what we're looking at, so others can follow us: always what's on screen, also once we stop
  // following without moving, or resize. A view taken from someone we follow is sent as theirs, so
  // two people following each other don't pass it back and forth (see sendViewport).
  const { sendViewport } = sync;
  useEffect(() => {
    if (!canvasSize.width) return;
    const followed = followingId && sameView(viewport, followedView.current) ? followingId : null;
    sendViewport({ ...viewport, width: canvasSize.width, height: canvasSize.height }, followed);
  }, [viewport, canvasSize, sendViewport, followedView, followingId]);

  // Suggestions (see suggestions.ts): drawn over the board for everyone, and decided on by members.
  const review = useSuggestionReview(sync, store);
  const elementById = useMemo(() => new Map(elements.map((element) => [element.id, element])), [elements]);
  const getElement = useCallback((id: string) => elementById.get(id), [elementById]);
  // A suggester's screen shows the board with their suggestions in it; this is the board without them (see
  // suggesting.ts), which their removals are drawn from and the panel reads. (Empty for everyone else.)
  const { elements: underneath } = useBoardSnapshot(sync.suggestedOver);
  const underneathById = useMemo(() => new Map(underneath.map((element) => [element.id, element])), [underneath]);
  const boardWithout = suggesting ? (id: string) => underneathById.get(id) : getElement;
  const isOwnGroup = (group: SuggestionGroup) => suggesting && group.author.userId === selfId;
  const withdraw = (group: SuggestionGroup) => sync.withdrawSuggestions(group.suggestions.map(({ id }) => id));
  const highlighted = useMemo(() => idsInGroup(review.groups, hoveredGroup), [review.groups, hoveredGroup]);
  const suggestionLayer = useMemo(() => {
    if (!showSuggestions) return undefined;
    const own: OwnSuggestions | undefined = suggesting
      ? { isOwn: (suggestion) => suggestion.author.userId === selfId, underneath: (id) => underneathById.get(id) }
      : undefined;
    return suggestionMarks(review.suggestions, getElement, highlighted, own);
  }, [showSuggestions, suggesting, selfId, review.suggestions, getElement, underneathById, highlighted]);
  const focusOn = (bounds: Rect) =>
    changeViewport((vp) => ({
      ...vp,
      x: canvasSize.width / 2 / vp.zoom - (bounds.x + bounds.width / 2),
      y: canvasSize.height / 2 / vp.zoom - (bounds.y + bounds.height / 2),
    }));

  const { threads, ...threadApi } = useThreads({ boardId: board.id, socket: sync.socket, enabled: commentsEnabled });
  const members = useMemo(
    () => [board.owner, ...board.collaborators].filter((person) => person && person.id !== selfId),
    [board.owner, board.collaborators, selfId],
  );

  // A notification links to ?thread=…: open that comment and bring it into view, once.
  const openedThread = useRef<string | null>(null);
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

  const placeComment = useCallback((point: XY) => {
    setActiveThread(null);
    setDraft(point);
  }, []);

  const renameBoard = useCallback(
    async (title: string): Promise<RenamedBoard> =>
      local ? { title } : (await api.renameBoard(board.id, title)).board,
    [local, board.id],
  );

  // Access can be lowered while the board is open: drop anything half-done.
  useEffect(() => {
    if (!readOnly) return;
    setSelectedId(null);
    setEditing(null);
    setDialog((current) => (current === "clear" ? null : current));
  }, [readOnly]);

  const changeTool = useCallback((next: ToolId) => {
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
    (factor: number) =>
      changeViewport((vp) => zoomAround(vp, vp.zoom * factor, canvasSize.width / 2, canvasSize.height / 2)),
    [canvasSize, changeViewport],
  );
  const resetZoom = () => changeViewport((vp) => zoomAround(vp, 1, canvasSize.width / 2, canvasSize.height / 2));
  const fitToScreen = useCallback(() => {
    const bounds = getSceneBounds(store.getElements());
    if (bounds) changeViewport(fitViewport(bounds, canvasSize, { padding: 96, maxZoom: 2 }));
  }, [store, canvasSize, changeViewport]);

  // The selected element and, for a frame, everything inside it: they're deleted,
  // copied and nudged together.
  const selectedGroup = useCallback(() => {
    const element = selectedId && store.getElement(selectedId);
    return element ? withContents(store.getElements(), element) : [];
  }, [selectedId, store]);

  // A message with an Undo button for the step just taken. It goes away once anything else is done,
  // because then Undo would undo that instead.
  const toastWithUndo = useCallback(
    (message: string) => {
      const mark = store.historyMark();
      let stopWatching = () => {};
      const id = toast(message, {
        action: { label: "Undo", onClick: () => store.undo() },
        onDismiss: () => stopWatching(),
        onAutoClose: () => stopWatching(),
      });
      stopWatching = store.subscribe(() => {
        if (store.historyMark() === mark) return;
        stopWatching();
        toast.dismiss(id);
      });
    },
    [store],
  );

  const deleteSelected = useCallback(() => {
    const group = selectedGroup();
    if (group.length === 0) return;
    // Connectors attached to what's deleted stay where they're drawn (the store lets go of them).
    store.commit({ undo: { upsert: group }, redo: { remove: group.map((element) => element.id) } });
    setSelectedId(null);
    if (group.length > 1) {
      const count = group.length - 1;
      toastWithUndo(`Frame and ${count} ${count === 1 ? "element" : "elements"} in it deleted`);
    }
  }, [selectedGroup, store, toastWithUndo]);

  const duplicateSelected = useCallback(() => {
    const group = selectedGroup();
    if (group.length === 0) return;
    // A frame's copy goes beside it, so the two don't overlap and claim each other's contents.
    const [dx, dy] = isFrame(group[0]) ? copyOffset(store.getElements(), group, FRAME_COPY_GAP) : [16, 16];
    const copies = copyGroup(store.getElements(), group, dx, dy);
    store.commit({ undo: { remove: copies.map((copy) => copy.id) }, redo: { upsert: copies } });
    setSelectedId(copies[0].id);
  }, [selectedGroup, store]);

  // "front", "forward", "backward" or "back" in the stack. Only the element's
  // stacking key changes, so it merges with anyone else's edits to it.
  const moveSelected = useCallback(
    (where: StackMove) => {
      const element = selectedId && store.getElement(selectedId);
      if (!element) return;
      const index = stackKey(store.getElements(), element, where);
      if (!index) return;
      store.commit({ undo: { upsert: [element] }, redo: { upsert: [{ ...element, index }] } });
    },
    [selectedId, store],
  );
  // Which stack moves are possible takes a pass over the board for each, so it's worked out
  // when the board is quiet, not on every step of a drag.
  const settledElements = useDeferredValue(elements);
  const settledSelection = useDeferredValue(selected);
  const stackMoves = useMemo<Partial<Record<StackMove, boolean>>>(
    () =>
      settledSelection && !readOnly
        ? Object.fromEntries(
            STACK_MOVES.map((where) => [where, stackKey(settledElements, settledSelection, where) !== null]),
          )
        : {},
    [settledElements, settledSelection, readOnly],
  );

  const nudgeSelected = useCallback(
    (dx: number, dy: number) => {
      const group = selectedGroup();
      if (group.length === 0) return;
      // Nudges in a row are one undo step while they move the same things. A
      // frame nudged over something takes it along from then on, and that's a
      // new step: the first one's undo doesn't know where it was.
      store.commit(
        { undo: { upsert: group }, redo: { upsert: moveGroup(store.getElements(), group, dx, dy) } },
        { mergeKey: `nudge:${group.map((element) => element.id).join(",")}` },
      );
    },
    [selectedGroup, store],
  );

  // Selecting with the select tool, so the element's own panel shows (Delete, Duplicate) and Enter edits it:
  // a frame just drawn, ready to be named or filled, or an element picked from the keyboard list.
  const selectElement = useCallback((id: string) => {
    setTool("select");
    setSelectedId(id);
  }, []);

  // Adds pictures to the board: shrinks and uploads each, then places it where it
  // was dropped, or in the middle of the screen. Each one is a single undo step.
  // The cast: filled in on the next line, on every render, before anything reads it.
  const view = useRef(null as unknown as ImportView);
  view.current = { viewport, canvasSize };

  // Picking an element from the keyboard-reachable list can select one that is off screen: bring it into view.
  // Only when the selection changes, not when the window is resized, and without leaving someone we follow.
  useEffect(() => {
    const { viewport, canvasSize } = view.current;
    const element = selectedId && canvasSize.width ? store.getElement(selectedId) : null;
    if (!element) return;
    const next = viewToReveal(viewport, canvasSize, getBounds(element));
    if (next !== viewport) setViewport(next);
  }, [selectedId, store]);
  const { addImages, importBoardFile } = useImageImport({
    store,
    socket: sync.socket,
    boardId: board.id,
    local,
    readOnly: readOnly || suggesting, // nothing pasted, dropped or imported is suggested
    view,
    setTool,
    setSelectedId,
  });

  useBoardShortcuts({
    store,
    readOnly,
    canComment,
    canAddImages,
    selectedId,
    fileInput,
    actions: {
      duplicateSelected,
      moveSelected,
      deleteSelected,
      nudgeSelected,
      zoomBy,
      resetZoom,
      fitToScreen,
      changeTool,
      stopFollowing,
    },
    setSpacePressed,
    setSelectedId,
    setDraft,
    setActiveThread,
    setEditing,
    setDialog,
  });

  function commitText(text: string) {
    // The editors that call this are shown only while something is being edited.
    const { element, isNew } = editing!;
    setEditing(null);
    const value = text.slice(0, MAX_TEXT_LENGTH).trimEnd(); // the same cut the server makes
    // An empty sticky note is still a note, and an arrow without a label still an arrow; empty text is nothing.
    const keepEmpty = element.type === "sticky" || isConnector(element);
    if (isNew) {
      if (!value.trim() && !keepEmpty) return;
      const created = { ...element, text: value };
      store.commit({ undo: { remove: [created.id] }, redo: { upsert: [created] } });
      return;
    }
    // The cast: only elements that carry text are edited, so the one on the board does too.
    const current = (store.getElement(element.id) ?? element) as TextBearing;
    if (value === (current.text ?? "")) return;
    if (!value.trim() && !keepEmpty) {
      store.commit({ undo: { upsert: [current] }, redo: { remove: [current.id] } });
    } else {
      store.commit({ undo: { upsert: [current] }, redo: { upsert: [{ ...current, text: value }] } });
    }
  }

  function changeStyle(key: StyleChange[0], value: StyleChange[1]) {
    // A note's color is its fill, but new notes keep their own color, apart from new shapes' fill.
    const styleKey = panelType === "sticky" && key === "fill" ? "noteFill" : key;
    if (key !== "name") setStyle((current) => ({ ...current, [styleKey]: value }));
    if (selected) {
      store.commit(
        { undo: { upsert: [selected] }, redo: { upsert: [{ ...selected, [key]: value }] } },
        { mergeKey: `style:${selected.id}:${key}` },
      );
    }
  }

  async function exportAs(exporter: Exporter) {
    try {
      const done = await exporter(store.getElements(), board.title);
      if (!done) toast("Draw something first. There's nothing to export yet.");
    } catch (error) {
      toast.error(error instanceof ExportError ? error.message : "The board couldn't be exported. Try again.");
    }
  }

  function clearBoard() {
    const all = store.getElements();
    store.commit({ undo: { upsert: all }, redo: { remove: all.map((element) => element.id) } });
    setSelectedId(null);
    setDialog(null);
    toastWithUndo("Board cleared");
  }

  const panelType = readOnly ? null : styleTarget(tool, selected);
  const others = useMemo(() => {
    const seen = new Map<string, Peer>();
    for (const peer of sync.peers) {
      if (peer.userId !== selfId && !seen.has(peer.userId)) seen.set(peer.userId, peer);
    }
    return [...seen.values()];
  }, [sync.peers, selfId]);

  const followed = others.find((person) => person.socketId === followingId);

  // Opens the new copy, which is the person's own board.
  async function makeCopy() {
    try {
      const { board: copy } = await api.copyBoard(board.id);
      navigate(`/board/${copy.id}`);
      toast.success("This is your copy. Changes here don't change the original.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function saveCurrentAsTemplate(title: string) {
    await api.saveTemplate(board.id, title);
    toast.success("Template saved. Find it when you start a new board.");
  }

  // The element being edited as it is now, so its editor follows it if someone moves it meanwhile.
  // The casts in what follows: what is drawn under an id is the same kind of element, so a connector stays one;
  // the editor for a note or for text is only shown for one; and the board's details are only changed once they are
  // there, so a rename never starts from null.
  const edited = editing && (elements.find((element) => element.id === editing.element.id) ?? editing.element);

  return (
    <div className="fixed inset-0 overflow-hidden select-none">
      <ErrorBoundary fallback={BoardCrashed}>
        <MemoBoardCanvas
          store={store}
          tool={readOnly && tool !== "comment" ? "hand" : tool}
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
          onFrameDrawn={selectElement}
          suggestions={suggestionLayer}
        />
      </ErrorBoundary>

      <input
        ref={boardFileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const [file] = event.target.files!; // a file input always has a list
          if (file) importBoardFile(file);
          event.target.value = "";
        }}
      />

      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,image/heic,image/heif"
        multiple
        hidden
        onChange={(event) => {
          addImages([...event.target.files!]);
          event.target.value = "";
        }}
      />

      <ElementList elements={elements} selectedId={selectedId} onSelect={selectElement} />
      <div role="status" className="sr-only">
        {selected ? `Selected: ${describeElement(selected)}` : ""}
      </div>

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
          canResolveAny={drawsOnBoard(role)}
          canDeleteAny={role === "owner"}
          selfId={selfId}
          api={threadApi}
        />
      )}

      {showSuggestions && review.groups.length > 0 && (
        <SuggestionChips
          groups={review.groups}
          viewport={viewport}
          getElement={(id) => getElement(id) ?? boardWithout(id)}
          canDecide={isMember}
          onAccept={(group) => review.accept(group.suggestions)}
          onReject={(group) => review.reject(group.suggestions)}
          onHover={setHoveredGroup}
          isOwn={isOwnGroup}
          onWithdraw={withdraw}
        />
      )}

      {editing &&
        (isConnector(editing.element) ? (
          <LabelEditor
            key={editing.element.id}
            element={editing.element}
            middle={pathMiddle(
              connectorPath((drawnElement(elements, editing.element.id) as Connector | undefined) ?? editing.element),
            )}
            viewport={viewport}
            onCommit={commitText}
          />
        ) : editing.element.type === "sticky" ? (
          <NoteEditor
            key={editing.element.id}
            element={edited as StickyElement}
            viewport={viewport}
            onCommit={commitText}
          />
        ) : (
          <TextEditor
            key={editing.element.id}
            element={edited as TextElement}
            viewport={viewport}
            onCommit={commitText}
          />
        ))}

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
          readOnly={readOnly || suggesting}
          onRenamed={(updated) => setMeta((current) => ({ ...current, ...updated }) as BoardMeta)}
        />
      </div>

      {/* Tools: top centre on wide screens, bottom on phones. Viewers get a notice instead, and suggesters one too. */}
      <div className="absolute inset-x-3 bottom-3 flex flex-col-reverse items-center gap-2 md:inset-x-auto md:top-3 md:bottom-auto md:left-1/2 md:-translate-x-1/2 md:flex-col">
        {readOnly ? (
          <ViewOnlyNotice
            signedIn={Boolean(user)}
            loginHref={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
            commenting={canComment ? tool === "comment" : undefined}
            onToggleComment={() => changeTool(tool === "comment" ? "hand" : "comment")}
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
        {suggesting && <SuggestingNotice />}
      </div>

      {/* Top right: people, share, menu */}
      <div className="absolute top-3 right-3 flex items-center gap-2">
        {others.length > 0 && (
          <div className="max-sm:hidden">
            <PresenceStack people={others} followingId={followingId} onFollow={follow} />
          </div>
        )}
        {!user && !local && <GuestIdentity socket={sync.socket} />}
        {(review.suggestions.length > 0 || board.linkAccess === "suggest") && (
          <Button
            variant="secondary"
            icon={MessageSquarePlus}
            onClick={() => {
              setHistoryOpen(false);
              setSuggestionsOpen((open) => !open);
            }}
            aria-pressed={suggestionsOpen}
            className="max-sm:px-3"
          >
            <span className="max-sm:sr-only">Suggestions</span>
            {review.suggestions.length > 0 && (
              <span className="rounded-full bg-signal px-1.5 text-xs leading-5 font-semibold text-white">
                {review.suggestions.length}
              </span>
            )}
          </Button>
        )}
        {local ? (
          <Button icon={Save} onClick={local.onSave} className="max-sm:px-3">
            <span className="max-sm:sr-only">Save board</span>
          </Button>
        ) : (
          <Button icon={UserPlus} onClick={() => setDialog("share")} className="max-sm:px-3">
            <span className="max-sm:sr-only">Share</span>
          </Button>
        )}
        <BoardMenu
          user={user}
          local={local}
          readOnly={readOnly || suggesting}
          isMember={isMember}
          commentsEnabled={commentsEnabled}
          showComments={showComments}
          isEmpty={elements.length === 0}
          onExport={exportAs}
          onImportFile={() => boardFileInput.current?.click()}
          onCopy={makeCopy}
          onHistory={() => {
            setSuggestionsOpen(false);
            setHistoryOpen(true);
          }}
          onTemplate={() => setDialog("template")}
          onToggleComments={() => setShowComments((shown) => !shown)}
          onShortcuts={() => setDialog("shortcuts")}
          onClear={() => setDialog("clear")}
        />
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
      {suggestionsOpen && (
        <SuggestionsPanel
          groups={review.groups}
          getElement={boardWithout}
          isOwn={isOwnGroup}
          onWithdraw={withdraw}
          canDecide={isMember}
          shown={showSuggestions}
          onToggleShown={() => setShowSuggestions((shown) => !shown)}
          onAccept={review.accept}
          onReject={review.reject}
          onHover={setHoveredGroup}
          onFocus={focusOn}
          onClose={() => setSuggestionsOpen(false)}
        />
      )}

      {/* Style panel */}
      {panelType && (
        <div className={clsx("absolute left-3 max-md:bottom-[7.5rem] md:top-20", !panelOpen && "max-md:hidden")}>
          <PropertiesPanel
            type={panelType}
            values={selected ?? (panelType === "sticky" ? { ...style, fill: style.noteFill } : style)}
            onChange={changeStyle}
            selection={Boolean(selected && tool === "select")}
            onDuplicate={duplicateSelected}
            onDelete={deleteSelected}
            stackMoves={stackMoves}
            onMove={moveSelected}
          />
        </div>
      )}

      <ViewControls
        store={store}
        readOnly={readOnly}
        canUndo={canUndo}
        canRedo={canRedo}
        zoom={viewport.zoom}
        canFit={elements.length > 0}
        onZoomBy={zoomBy}
        onResetZoom={resetZoom}
        onFit={fitToScreen}
        showStyleButton={Boolean(panelType)}
        styleOpen={panelOpen}
        onToggleStyle={() => setPanelOpen((open) => !open)}
      />

      <div className="absolute right-3 bottom-[4.25rem] flex items-center gap-2 md:bottom-3">
        <SyncStatus
          online={sync.online}
          saving={sync.saving}
          readOnly={readOnly}
          local={Boolean(local)}
          unsaved={sync.unsaved}
        />
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
          initialEmail={linkedInvite ?? ""}
          onBoardChange={(updated) => setMeta((current) => ({ ...current, ...updated }))}
          onLeft={() => {
            toast(`You left “${board.title}”`);
            navigate("/boards");
          }}
        />
      )}
      <ShortcutsDialog
        open={dialog === "shortcuts"}
        onClose={() => setDialog(null)}
        readOnly={readOnly}
        canComment={canComment}
      />
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
