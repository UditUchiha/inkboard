import clsx from "clsx";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoardCrashed, ErrorBoundary } from "../../../components/ErrorBoundary";
import type { AccountUser, BoardMeta } from "../../../lib/api";
import { getGuest } from "../../../lib/guest";
import { DEFAULT_STYLE } from "../constants/board";
import type { ToolId } from "../constants/board";
import type { DialogName } from "../constants/editor";
import { canChange } from "../lib/elements/classroom";
import { useBoardSnapshot } from "../lib/sync/store";
import type { BoardStore } from "../lib/sync/store";
import type { BoardSync } from "../hooks/useBoardSync";
import { useBoardShortcuts } from "../hooks/useBoardShortcuts";
import { useClassroomZone } from "../hooks/useClassroomZone";
import { useCommentsUi } from "../hooks/useCommentsUi";
import { useEditorActions } from "../hooks/useEditorActions";
import { useEditorViewport, useRevealInView } from "../hooks/useEditorViewport";
import { useImageImport } from "../hooks/useImageImport";
import { useLinkedPanels } from "../hooks/useLinkedPanels";
import { useOtherPeople } from "../hooks/useOtherPeople";
import { usePresenting } from "../hooks/usePresenting";
import { useSuggestionsUi } from "../hooks/useSuggestionsUi";
import { useUndoToast } from "../hooks/useUndoToast";
import { useVotingTool } from "../hooks/useVotingTool";
import { BoardCanvas } from "./BoardCanvas";
import { BoardOverlays } from "./BoardOverlays";
import { EditorChrome } from "./EditorChrome";
import { EditorDialogs } from "./EditorDialogs";
import { ElementList } from "./ElementList";
import { FileInputs } from "./FileInputs";
import { Presenter } from "./Presenter";
import { RemoteCursors } from "./RemoteCursors";
import { ReplayPlayer } from "./ReplayPlayer";
import { SelectionAnnouncer } from "./SelectionAnnouncer";
import { styleTarget } from "./StylePanel";

// The canvas only redraws when its own props change, not for every pointer or cursor message elsewhere.
const MemoBoardCanvas = memo(BoardCanvas);

export interface BoardEditorProps {
  store: BoardStore;
  sync: BoardSync & { unsaved?: boolean };
  user: AccountUser | null;
  local?: { onSave: () => void } | null;
}

// `local` is a guest's scratch board in the browser: no server, so sharing, history and comments give way to "Save board".
export function BoardEditor({ store, sync, user, local = null }: BoardEditorProps) {
  const { elements, canUndo, canRedo } = useBoardSnapshot(store);
  // The cast: the editor is only shown once the board's details are there (a scratch board has them from the start).
  const { meta: board, setMeta, role } = sync as BoardSync & { meta: BoardMeta };
  // Suggesters draw too, but what they do is sent as suggestions (see suggesting.ts), so the board's own settings aren't theirs.
  const readOnly = role === "viewer";
  const suggesting = role === "suggester";
  const isMember = role === "owner" || role === "editor";
  // Comments are for signed-in people, viewers and suggesters included.
  const commentsEnabled = Boolean(user) && !local;
  const canComment = commentsEnabled;
  const selfId = user?.id ?? getGuest().id;

  const [tool, setTool] = useState<ToolId>("pen");
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogName | null>(null);
  // Cropping a picture: its handles crop instead of resize; selecting anything else ends it.
  const [croppingId, setCroppingId] = useState<string | null>(null);
  useEffect(() => setCroppingId(null), [selectedId]);
  const fileInput = useRef<HTMLInputElement>(null);
  const boardFileInput = useRef<HTMLInputElement>(null);

  const vp = useEditorViewport(store, sync);
  const { viewport, canvasSize, changeViewport } = vp;
  const linked = useLinkedPanels({ role, isMember, local: Boolean(local), board, setDialog });
  const selected = selectedId ? (store.getElement(selectedId) ?? null) : null;
  const elementById = useMemo(() => new Map(elements.map((element) => [element.id, element])), [elements]);
  const getElement = useCallback((id: string) => elementById.get(id), [elementById]);
  const { classroom, classroomOn, student, myFrame, zone, frameClaims, keepInZone } = useClassroomZone({
    sync,
    store,
    local: Boolean(local),
    elementById,
  });
  // A guest's scratch board lives in the browser, with nowhere to keep files; pictures can't be suggested.
  const canAddImages = !readOnly && !local && !suggesting && !student;
  const suggestions = useSuggestionsUi({ sync, store, getElement, selfId, suggesting, canvasSize, changeViewport });
  const comments = useCommentsUi({
    sync,
    board,
    selfId,
    enabled: commentsEnabled,
    canvasSize,
    setViewport: vp.setViewport,
  });

  useEffect(() => {
    if (!canComment && tool === "comment") setTool("pen");
  }, [canComment, tool]);

  const changeTool = useCallback((next: ToolId) => {
    setTool(next);
    if (next !== "select") setSelectedId(null);
  }, []);
  const castVote = useVotingTool({ store, sync, readOnly, setTool, changeTool });
  const slideshow = usePresenting({
    sync,
    elements,
    selectedId,
    setSelectedId,
    canvasSize,
    changeViewport,
  });
  const { slides, presenting, shownFrame, setSlide, stopPresenting, sendLaser } = slideshow;
  const toastWithUndo = useUndoToast(store);

  // Select tool, so the element's own panel shows (Delete, Duplicate) and Enter edits it.
  const selectElement = useCallback((id: string) => {
    setTool("select");
    setSelectedId(id);
  }, []);
  const actions = useEditorActions({
    store,
    sync,
    board,
    elements,
    selected,
    selectedId,
    setSelectedId,
    selectElement,
    setDialog,
    tool,
    style,
    zone,
    student,
    readOnly,
    keepInZone,
    classroom,
    myFrame,
    vp,
    toastWithUndo,
  });

  const { selection, text, insertions, classroomActions, connect } = actions;
  useRevealInView(store, vp.view, vp.setViewport, connect.connectTo?.id ?? selectedId);
  const { addImages, importBoardFile } = useImageImport({
    store,
    socket: sync.socket,
    boardId: board.id,
    local,
    readOnly: readOnly || suggesting || student, // nothing pasted, dropped or imported is suggested, or a student's
    view: vp.view,
    setTool,
    setSelectedId,
  });
  useBoardShortcuts({
    store,
    readOnly,
    canComment,
    canAddImages,
    selectedId,
    connecting: Boolean(connect.connectTo),
    fileInput,
    actions: { ...selection, ...insertions, ...connect, ...vp, changeTool },
    setSpacePressed,
    setSelectedId,
    setDraft: comments.setDraft,
    setActiveThread: comments.setActiveThread,
    setEditing: text.editText,
    setDialog,
  });

  const panelType = readOnly || (selected && !canChange(selected, zone)) ? null : styleTarget(tool, selected);
  const others = useOtherPeople(sync, selfId);

  return (
    <div className={clsx("fixed inset-0 overflow-hidden select-none", presenting && "laser-pointer")}>
      <ErrorBoundary fallback={BoardCrashed}>
        <MemoBoardCanvas
          store={store}
          tool={presenting || (readOnly && tool !== "comment" && tool !== "vote") ? "hand" : tool}
          style={style}
          viewport={viewport}
          onViewportChange={changeViewport}
          // A student's selection of what they can't change (picked from the outline) has no handles to drag.
          selectedId={selected && !canChange(selected, zone) ? null : selectedId}
          onSelect={setSelectedId}
          connectTargetId={connect.connectTo?.id}
          editingId={text.editing?.element.id}
          onEditText={text.editText}
          spacePressed={spacePressed}
          onCursorMove={presenting ? sendLaser : sync.sendCursor}
          onSizeChange={vp.setCanvasSize}
          onPlaceComment={comments.placeComment}
          onVote={castVote}
          onFrameDrawn={selectElement}
          zone={zone}
          onOutsideZone={classroomActions.pressOutsideZone}
          frameClaims={frameClaims}
          suggestions={suggestions.suggestionLayer}
          croppingId={croppingId}
        />
      </ErrorBoundary>

      <FileInputs
        boardFileRef={boardFileInput}
        imageRef={fileInput}
        onBoardFile={importBoardFile}
        onImages={addImages}
      />
      <ElementList
        elements={elements}
        selectedId={selectedId}
        onSelect={selectElement}
        open={outlineOpen && !presenting}
        onOpenChange={setOutlineOpen}
      />
      <SelectionAnnouncer
        selected={selected}
        connectTo={connect.connectTo}
        connectIndex={connect.connectIndex}
        connectCount={connect.connectOptions.length}
        getElement={getElement}
      />
      <RemoteCursors cursors={sync.cursors} peers={sync.peers} viewport={viewport} />

      {/* While presenting, only the board and the presenter's bar: everything else comes back after. */}
      {shownFrame ? (
        <Presenter slides={slides} index={slides.indexOf(shownFrame)} onIndex={setSlide} onExit={stopPresenting} />
      ) : (
        !presenting && (
          <>
            <BoardOverlays
              sync={sync}
              elements={elements}
              viewport={viewport}
              canvasSize={canvasSize}
              role={role}
              selfId={selfId}
              isMember={isMember}
              commentsEnabled={commentsEnabled}
              canComment={canComment}
              comments={comments}
              suggestions={suggestions}
              text={text}
              getElement={getElement}
            />
            <EditorChrome
              store={store}
              sync={sync}
              board={board}
              setMeta={setMeta}
              user={user}
              local={local}
              role={role}
              readOnly={readOnly}
              suggesting={suggesting}
              student={student}
              isMember={isMember}
              canComment={canComment}
              commentsEnabled={commentsEnabled}
              canAddImages={canAddImages}
              tool={tool}
              onToolChange={changeTool}
              style={style}
              setStyle={setStyle}
              selected={selected}
              selectedId={selectedId}
              zone={zone}
              elements={elements}
              elementById={elementById}
              panelType={panelType}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen((open) => !open)}
              outlineOpen={outlineOpen}
              onToggleOutline={() => setOutlineOpen((open) => !open)}
              croppingId={croppingId}
              setCroppingId={setCroppingId}
              imageInput={fileInput}
              boardFileInput={boardFileInput}
              setDialog={setDialog}
              classroom={classroom}
              classroomOn={classroomOn}
              myFrame={myFrame}
              canUndo={canUndo}
              canRedo={canRedo}
              viewport={viewport}
              vp={vp}
              others={others}
              comments={comments}
              suggestions={suggestions}
              linked={linked}
              presenting={slideshow}
              actions={actions}
            />
          </>
        )
      )}

      {linked.replayOpen && !local && (
        <ReplayPlayer title={board.title} load={sync.loadReplay} onClose={linked.closeReplay} />
      )}
      <EditorDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        store={store}
        board={board}
        setMeta={setMeta}
        role={role}
        user={user}
        local={Boolean(local)}
        readOnly={readOnly}
        student={student}
        canComment={canComment}
        linkedInvite={linked.linkedInvite}
        visibleArea={vp.visibleArea}
        actions={actions}
      />
    </div>
  );
}
