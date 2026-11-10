import type { Element as BoardElement, FrameElement } from "@inkboard/shared/types";
import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { BoardMeta } from "../../../lib/api";
import type { Style, ToolId } from "../constants/board";
import type { DialogName } from "../constants/editor";
import type { Zone } from "../lib/elements/classroom";
import type { BoardStore } from "../lib/sync/store";
import type { BoardSync } from "./useBoardSync";
import { useBoardCommands } from "./useBoardCommands";
import { useBoardInsertions } from "./useBoardInsertions";
import { useClassroomActions } from "./useClassroomActions";
import { useConnectFromKeyboard } from "./useConnectFromKeyboard";
import type { useEditorViewport } from "./useEditorViewport";
import { useHandwritingEquation } from "./useHandwritingEquation";
import { useSelectionActions } from "./useSelectionActions";
import { useTextEditing } from "./useTextEditing";

interface EditorActionsOptions {
  store: BoardStore;
  sync: BoardSync;
  board: BoardMeta;
  elements: BoardElement[];
  selected: BoardElement | null;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectElement: (id: string) => void;
  setDialog: Dispatch<SetStateAction<DialogName | null>>;
  tool: ToolId;
  style: Style;
  zone: Zone;
  student: boolean;
  readOnly: boolean;
  keepInZone: <T extends BoardElement>(element: T) => T | null;
  classroom: BoardSync["classroom"];
  myFrame: FrameElement | null;
  vp: ReturnType<typeof useEditorViewport>;
  toastWithUndo: (message: string) => void;
}

// What the editor does to the board: the hooks that change elements, composed over the same store and view.
export function useEditorActions({
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
}: EditorActionsOptions) {
  const { viewport, canvasSize, changeViewport, visibleArea } = vp;
  const selection = useSelectionActions({
    store,
    elements,
    selected,
    selectedId,
    setSelectedId,
    zone,
    readOnly,
    zoom: viewport.zoom,
    toastWithUndo,
  });
  const text = useTextEditing({ store, elements, zone, keepInZone });
  const { setEditing } = text;

  // Access can be lowered while the board is open: drop anything half-done.
  useEffect(() => {
    if (!readOnly) return;
    setSelectedId(null);
    setEditing(null);
    setDialog((current) => (current === "clear" ? null : current));
  }, [readOnly, setSelectedId, setEditing, setDialog]);

  const insertions = useBoardInsertions({
    store,
    zone,
    tool,
    style,
    zoom: viewport.zoom,
    canvasSize,
    changeViewport,
    visibleArea,
    setEditing,
    selectElement,
    keepInZone,
    toastWithUndo,
  });
  const classroomActions = useClassroomActions({
    store,
    sync,
    classroom,
    zone,
    myFrame,
    tool,
    canvasSize,
    changeViewport,
    addDrawing: insertions.addDrawing,
  });
  const connect = useConnectFromKeyboard({ store, elements, selected, selectedId, zone, style, selectElement });
  const handwriting = useHandwritingEquation({
    store,
    selected,
    zone,
    student,
    style,
    keepInZone,
    selectElement,
    toastWithUndo,
    openAiDialog: () => setDialog("ai"),
  });
  const commands = useBoardCommands({
    store,
    board,
    toastWithUndo,
    setSelectedId,
    closeDialog: () => setDialog(null),
  });

  return { selection, text, insertions, classroomActions, connect, handwriting, commands };
}

export type EditorActions = ReturnType<typeof useEditorActions>;
