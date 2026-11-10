import { MAX_TEXT_LENGTH } from "@inkboard/shared/element-rules";
import type { Element as BoardElement, StickyElement, TextElement } from "@inkboard/shared/types";
import { useCallback, useState } from "react";
import type { TextEdit } from "../constants/editor";
import { canChange } from "../lib/elements/classroom";
import type { Zone } from "../lib/elements/classroom";
import { isConnector } from "../lib/elements/connectors";
import type { Connector } from "../lib/elements/elements";
import { mathSource } from "../lib/elements/math";
import type { BoardStore } from "../lib/sync/store";

type TextBearing = TextElement | StickyElement | Connector;

interface TextEditingOptions {
  store: BoardStore;
  elements: BoardElement[];
  zone: Zone;
  keepInZone: <T extends BoardElement>(element: T) => T | null;
}

export function useTextEditing({ store, elements, zone, keepInZone }: TextEditingOptions) {
  const [editing, setEditing] = useState<TextEdit | null>(null);
  // Classroom mode: an element picked from the outline may not be the student's to edit.
  const editText = useCallback(
    (edit: TextEdit) => {
      if (edit.isNew || canChange(edit.element, zone)) setEditing(edit);
    },
    [zone],
  );

  // `base` is the text as the board had it when the editor last took in others' typing (see TextEditor.tsx).
  function commitText(text: string, base: string) {
    // The editors that call this are shown only while something is being edited.
    const { element, isNew } = editing!;
    setEditing(null);
    const value = text.slice(0, MAX_TEXT_LENGTH).trimEnd(); // the same cut the server makes
    // An empty sticky note is still a note, and an arrow without a label still an arrow; empty text is nothing.
    const keepEmpty = element.type === "sticky" || isConnector(element);
    if (isNew) {
      // An equation left as $$ $$ is as empty as a text left blank.
      if (!(mathSource(value) ?? value).trim() && !keepEmpty) return;
      const created = keepInZone({ ...element, text: value });
      if (created) store.commit({ undo: { remove: [created.id] }, redo: { upsert: [created] } });
      return;
    }
    // The cast: only elements that carry text are edited, so the one on the board does too.
    const current = (store.getElement(element.id) ?? element) as TextBearing;
    if (value === base || value === (current.text ?? "")) return;
    if (!value.trim() && !keepEmpty) {
      store.commit({ undo: { upsert: [current] }, redo: { remove: [current.id] } });
      return;
    }
    // Made from the text it was typed against, so typing that reached the board since is kept (see store.ts).
    const changed = keepInZone({ ...current, text: value });
    if (changed) store.commit({ undo: { upsert: [{ ...current, text: base }] }, redo: { upsert: [changed] } });
  }

  // The editor follows the element if someone moves it meanwhile.
  const edited = editing && (elements.find((element) => element.id === editing.element.id) ?? editing.element);

  return { editing, setEditing, editText, commitText, edited };
}

export type TextEditing = ReturnType<typeof useTextEditing>;
