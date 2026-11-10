import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ConfirmDialog } from "../../../components/Dialog";
import { api } from "../../../lib/api";
import type { AccountUser, BoardMeta, Role } from "../../../lib/api";
import { getGuest } from "../../../lib/guest";
import type { DialogName } from "../constants/editor";
import type { Rect } from "../lib/elements/geometry";
import type { BoardStore } from "../lib/sync/store";
import type { BoardSync } from "../hooks/useBoardSync";
import type { EditorActions } from "../hooks/useEditorActions";
import { AiDrawDialog } from "./AiDrawDialog";
import { ClaimFrameDialog } from "./ClassroomPanels";
import { EquationDialog } from "./EquationDialog";
import { MermaidImportDialog } from "./MermaidImportDialog";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
import { ShareDialog } from "./ShareDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";

export interface EditorDialogsProps {
  dialog: DialogName | null;
  onClose: () => void;
  store: BoardStore;
  board: BoardMeta;
  setMeta: BoardSync["setMeta"];
  role: Role;
  user: AccountUser | null;
  local: boolean;
  readOnly: boolean;
  student: boolean;
  canComment: boolean;
  linkedInvite: string | null;
  visibleArea: () => Rect;
  actions: EditorActions;
}

export function EditorDialogs({
  dialog,
  onClose,
  store,
  board,
  setMeta,
  role,
  user,
  local,
  readOnly,
  student,
  canComment,
  linkedInvite,
  visibleArea,
  actions,
}: EditorDialogsProps) {
  const { insertions, handwriting, classroomActions, commands } = actions;
  const navigate = useNavigate();

  async function saveCurrentAsTemplate(title: string) {
    await api.saveTemplate(board.id, title);
    toast.success("Template saved. Find it when you start a new board.");
  }

  return (
    <>
      {student && (
        <ClaimFrameDialog
          frame={classroomActions.claiming}
          guestName={user ? null : getGuest().name}
          onClaim={classroomActions.claimFrame}
          onClose={() => classroomActions.setClaiming(null)}
        />
      )}

      {!readOnly && (
        <MermaidImportDialog
          open={dialog === "mermaid"}
          onClose={onClose}
          getCentre={() => {
            const view = visibleArea();
            return { x: view.x + view.width / 2, y: view.y + view.height / 2 };
          }}
          onImported={insertions.addMermaid}
        />
      )}
      {!readOnly && (
        <AiDrawDialog
          open={dialog === "ai"}
          onClose={onClose}
          getBoard={store.getElements}
          getView={visibleArea}
          onDrawn={insertions.addAiDrawing}
        />
      )}
      {!readOnly && (
        <EquationDialog
          strokes={handwriting.readingStrokes}
          onClose={() => handwriting.setReadingStrokes(null)}
          onInsert={handwriting.insertEquation}
        />
      )}
      <SaveTemplateDialog
        open={dialog === "template"}
        onClose={onClose}
        defaultTitle={board.title}
        onSave={saveCurrentAsTemplate}
      />
      {!local && (
        <ShareDialog
          open={dialog === "share"}
          onClose={onClose}
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
      <ShortcutsDialog open={dialog === "shortcuts"} onClose={onClose} readOnly={readOnly} canComment={canComment} />
      <ConfirmDialog
        open={dialog === "clear"}
        onClose={onClose}
        onConfirm={commands.clearBoard}
        title="Clear the whole board?"
        description="This removes every drawing for everyone on the board. You can undo it right after."
        confirmLabel="Clear board"
      />
    </>
  );
}
