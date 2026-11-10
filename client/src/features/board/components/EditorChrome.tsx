import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Element as BoardElement, ElementType, FrameElement } from "@inkboard/shared/types";
import type { AccountUser, BoardMeta, Role } from "../../../lib/api";
import type { Style, ToolId } from "../constants/board";
import type { DialogName } from "../constants/editor";
import type { Zone } from "../lib/elements/classroom";
import type { Viewport } from "../lib/elements/geometry";
import type { BoardStore } from "../lib/sync/store";
import type { BoardSync, Peer } from "../hooks/useBoardSync";
import type { CommentsUi } from "../hooks/useCommentsUi";
import type { EditorActions } from "../hooks/useEditorActions";
import type { EditorViewport } from "../hooks/useEditorViewport";
import type { LinkedPanels } from "../hooks/useLinkedPanels";
import type { Presenting } from "../hooks/usePresenting";
import type { SuggestionsUi } from "../hooks/useSuggestionsUi";
import { BoardActions } from "./BoardActions";
import { BoardCornerTools } from "./BoardCornerTools";
import { BoardHeader } from "./BoardHeader";
import { BoardMenu } from "./BoardMenu";
import { FollowingBanner } from "./FollowingBanner";
import { StylePanel } from "./StylePanel";
import { SuggestionsPanel } from "./SuggestionsPanel";
import { ToolbarStack } from "./ToolbarStack";
import { VersionHistory } from "./VersionHistory";
import { ViewControls } from "./ViewControls";

export interface EditorChromeProps {
  store: BoardStore;
  sync: BoardSync & { unsaved?: boolean };
  board: BoardMeta;
  setMeta: BoardSync["setMeta"];
  user: AccountUser | null;
  local: { onSave: () => void } | null;
  role: Role;
  readOnly: boolean;
  suggesting: boolean;
  student: boolean;
  isMember: boolean;
  canComment: boolean;
  commentsEnabled: boolean;
  canAddImages: boolean;
  tool: ToolId;
  onToolChange: (tool: ToolId) => void;
  style: Style;
  setStyle: Dispatch<SetStateAction<Style>>;
  selected: BoardElement | null;
  selectedId: string | null;
  zone: Zone;
  elements: BoardElement[];
  elementById: ReadonlyMap<string, BoardElement>;
  panelType: ElementType | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  croppingId: string | null;
  setCroppingId: Dispatch<SetStateAction<string | null>>;
  imageInput: RefObject<HTMLInputElement | null>;
  boardFileInput: RefObject<HTMLInputElement | null>;
  setDialog: Dispatch<SetStateAction<DialogName | null>>;
  classroom: BoardSync["classroom"];
  classroomOn: boolean;
  myFrame: FrameElement | null;
  canUndo: boolean;
  canRedo: boolean;
  viewport: Viewport;
  vp: EditorViewport;
  others: Peer[];
  comments: CommentsUi;
  suggestions: SuggestionsUi;
  linked: LinkedPanels;
  presenting: Presenting;
  actions: EditorActions;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onHideUi: () => void;
}

// The panels and controls around the canvas: header, tools, menu, side panels, zoom and status.
export function EditorChrome({
  store,
  sync,
  board,
  setMeta,
  user,
  local,
  role,
  readOnly,
  suggesting,
  student,
  isMember,
  canComment,
  commentsEnabled,
  canAddImages,
  tool,
  onToolChange,
  style,
  setStyle,
  selected,
  selectedId,
  zone,
  elements,
  elementById,
  panelType,
  panelOpen,
  onTogglePanel,
  outlineOpen,
  onToggleOutline,
  croppingId,
  setCroppingId,
  imageInput,
  boardFileInput,
  setDialog,
  classroom,
  classroomOn,
  myFrame,
  canUndo,
  canRedo,
  viewport,
  vp,
  others,
  comments,
  suggestions,
  linked,
  presenting,
  actions,
  fullscreen,
  onToggleFullscreen,
  onHideUi,
}: EditorChromeProps) {
  const { selection, insertions, classroomActions, handwriting, commands } = actions;
  const { review } = suggestions;
  const followed = others.find((person) => person.socketId === vp.followingId);

  return (
    <>
      <BoardHeader
        board={board}
        user={user}
        local={Boolean(local)}
        readOnly={readOnly || suggesting}
        onRenamed={(updated) => setMeta((current) => ({ ...current, ...updated }) as BoardMeta)}
      />
      <ToolbarStack
        sync={sync}
        boardId={board.id}
        user={user}
        role={role}
        local={Boolean(local)}
        tool={tool}
        onToolChange={onToolChange}
        readOnly={readOnly}
        suggesting={suggesting}
        student={student}
        isMember={isMember}
        canComment={canComment}
        onAddImage={canAddImages ? () => imageInput.current?.click() : undefined}
        onAddEquation={insertions.addEquation}
        onAiDraw={student ? undefined : () => setDialog("ai")}
        elements={elements}
        elementById={elementById}
        classroom={classroom}
        classroomOn={classroomOn}
        myFrameName={myFrame ? myFrame.name || "Untitled frame" : null}
        onGoToMyFrame={classroomActions.goToMyFrame}
      />
      <BoardActions
        people={others}
        followingId={vp.followingId}
        onFollow={vp.follow}
        user={user}
        local={local}
        guestVersion={classroomActions.guestVersion}
        socket={sync.socket}
        suggestionCount={review.suggestions.length}
        showSuggestionsButton={review.suggestions.length > 0 || board.linkAccess === "suggest"}
        suggestionsOpen={linked.suggestionsOpen}
        onToggleSuggestions={linked.toggleSuggestions}
        onShare={() => setDialog("share")}
      >
        <BoardMenu
          user={user}
          local={local}
          readOnly={readOnly || suggesting || student}
          isMember={isMember}
          commentsEnabled={commentsEnabled}
          showComments={comments.showComments}
          isEmpty={elements.length === 0}
          canPresent={presenting.slides.length > 0}
          onPresent={presenting.startPresenting}
          canReplay={linked.canReplay}
          onReplay={() => linked.setReplayOpen(true)}
          onExport={commands.exportAs}
          onImportFile={() => boardFileInput.current?.click()}
          onImportMermaid={() => setDialog("mermaid")}
          onCopy={commands.makeCopy}
          onHistory={linked.openHistory}
          onTemplate={() => setDialog("template")}
          onToggleComments={() => comments.setShowComments((shown) => !shown)}
          onShortcuts={() => setDialog("shortcuts")}
          onHideUi={onHideUi}
          onClear={() => setDialog("clear")}
        />
      </BoardActions>

      {followed && <FollowingBanner name={followed.name} onStop={vp.stopFollowing} />}
      {linked.historyOpen && isMember && (
        <VersionHistory boardId={board.id} onClose={() => linked.setHistoryOpen(false)} />
      )}
      {linked.suggestionsOpen && (
        <SuggestionsPanel
          groups={review.groups}
          getElement={suggestions.boardWithout}
          isOwn={suggestions.isOwnGroup}
          onWithdraw={suggestions.withdraw}
          canDecide={isMember}
          shown={suggestions.showSuggestions}
          onToggleShown={() => suggestions.setShowSuggestions((shown) => !shown)}
          onAccept={review.accept}
          onReject={review.reject}
          onHover={suggestions.setHoveredGroup}
          onFocus={suggestions.focusOn}
          onClose={() => linked.setSuggestionsOpen(false)}
        />
      )}
      {panelType && (
        <StylePanel
          store={store}
          type={panelType}
          tool={tool}
          style={style}
          setStyle={setStyle}
          selected={selected}
          zone={zone}
          open={panelOpen}
          stackMoves={selection.stackMoves}
          cropping={croppingId !== null}
          onToggleCrop={() => setCroppingId((id) => (id ? null : selectedId))}
          onUncrop={selection.uncropSelected}
          onDuplicate={selection.duplicateSelected}
          onDelete={selection.deleteSelected}
          onMove={selection.moveSelected}
          onConvertToEquation={handwriting.convertToEquation}
          isMember={isMember}
          local={Boolean(local)}
          classroom={classroom}
          onReleaseFrame={(frameId) => void classroomActions.releaseFrame(frameId)}
          onCopyFrame={classroomActions.copyFrameForClass}
        />
      )}
      <ViewControls
        store={store}
        readOnly={readOnly}
        canUndo={canUndo}
        canRedo={canRedo}
        zoom={viewport.zoom}
        canFit={elements.length > 0}
        onZoomBy={vp.zoomBy}
        onResetZoom={vp.resetZoom}
        onFit={vp.fitToScreen}
        showStyleButton={Boolean(panelType)}
        styleOpen={panelOpen}
        onToggleStyle={onTogglePanel}
        outlineOpen={outlineOpen}
        onToggleOutline={onToggleOutline}
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
      <BoardCornerTools
        sync={sync}
        role={role}
        local={Boolean(local)}
        readOnly={readOnly}
        isMember={isMember}
        classroomOn={classroomOn}
        onStartClassroom={() => void classroomActions.startClassroom()}
        onShortcuts={() => setDialog("shortcuts")}
      />
    </>
  );
}
