import type { Element as BoardElement, StickyElement, TextElement } from "@inkboard/shared/types";
import type { TextEdit } from "../constants/editor";
import { drawnElement, isConnector } from "../lib/elements/connectors";
import type { Connector } from "../lib/elements/elements";
import type { Viewport } from "../lib/elements/geometry";
import { connectorPath, pathMiddle } from "../lib/elements/routes";
import { LabelEditor, NoteEditor, TextEditor } from "./TextEditor";

export interface InlineTextEditorProps {
  editing: TextEdit;
  // The element being edited as it is on the board now.
  edited: BoardElement;
  elements: BoardElement[];
  viewport: Viewport;
  onCommit: (text: string, base: string) => void;
}

export function InlineTextEditor({ editing, edited, elements, viewport, onCommit }: InlineTextEditorProps) {
  // The casts: the editor for a note or for text is only shown for one, and a line's label is edited on a connector.
  if (isConnector(editing.element)) {
    return (
      <LabelEditor
        key={editing.element.id}
        element={edited as Connector}
        middle={pathMiddle(
          connectorPath((drawnElement(elements, editing.element.id) as Connector | undefined) ?? editing.element),
        )}
        viewport={viewport}
        onCommit={onCommit}
      />
    );
  }
  if (editing.element.type === "sticky") {
    return (
      <NoteEditor key={editing.element.id} element={edited as StickyElement} viewport={viewport} onCommit={onCommit} />
    );
  }
  return (
    <TextEditor key={editing.element.id} element={edited as TextElement} viewport={viewport} onCommit={onCommit} />
  );
}
