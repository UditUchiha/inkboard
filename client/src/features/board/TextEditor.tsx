import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { MAX_TEXT_LENGTH } from "@inkboard/shared/element-rules";
import type { StickyElement, TextElement } from "@inkboard/shared/types";
import { FONTS, LABEL_FONT_SIZE, LINE_HEIGHT, NOTE_TEXT_COLOR, fontKey } from "./constants";
import { fontFor, measureText } from "./elements";
import type { Connector } from "./elements";
import { normalizeRect, toScreen } from "./geometry";
import type { Viewport, XY } from "./geometry";
import { noteLayout } from "./notes";

// What the server keeps of a text (see MAX_TEXT_LENGTH), without half an emoji left at the end.
export function cutText(value: string): string {
  const kept = value.slice(0, MAX_TEXT_LENGTH);
  return kept.length < value.length && /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
}

// A key pressed in one of the editors' textareas.
type InlineKeyEvent = KeyboardEvent<HTMLTextAreaElement>;

// Keys pressed to pick or cancel what an input method is composing (Japanese, Chinese, Korean…) aren't for the editor.
const composing = (event: InlineKeyEvent) => event.nativeEvent.isComposing || event.keyCode === 229;

// Ctrl or Cmd + Enter finishes text and notes (Enter starts a new line); Enter finishes a label.
const finishesText = (event: InlineKeyEvent) =>
  event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey));
const finishesLabel = (event: InlineKeyEvent) => event.key === "Escape" || (event.key === "Enter" && !event.shiftKey);

/**
 * What the three inline editors share: a textarea that takes focus when it opens (with the
 * caret at the end, or everything selected if `selectAll`), commits once (on blur, which
 * is also how a key that `finishes` the edit ends it), and keeps its keys to itself.
 * Spread `inputProps` onto the textarea.
 */
function useInlineEditor(
  initial: string,
  onCommit: (text: string) => void,
  { finishes, selectAll = false }: { finishes: (event: InlineKeyEvent) => boolean; selectAll?: boolean },
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(false);
  const [value, setValue] = useState(initial);

  useEffect(() => {
    // Deferred so the click that opened the editor doesn't immediately blur it.
    const timer = setTimeout(() => {
      const textarea = ref.current;
      if (!textarea) return;
      textarea.focus();
      if (selectAll) textarea.select();
      else textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 0);
    return () => clearTimeout(timer);
  }, [selectAll]);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(cutText(value));
  };

  const inputProps = {
    ref,
    value,
    maxLength: MAX_TEXT_LENGTH,
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value),
    onBlur: commit,
    onKeyDown: (event: InlineKeyEvent) => {
      event.stopPropagation();
      if (composing(event)) return;
      if (finishes(event)) {
        event.preventDefault();
        event.currentTarget.blur();
      }
    },
    spellCheck: false,
  };
  return { value, inputProps };
}

/** What each inline editor takes: the viewport it is placed by, and what to do with the text once it is done. */
type EditorProps = { viewport: Viewport; onCommit: (text: string) => void };

/** What the text editor takes: the text being edited. */
export type TextEditorProps = EditorProps & { element: TextElement };

export function TextEditor({ element, viewport, onCommit }: TextEditorProps) {
  const { value, inputProps } = useInlineEditor(element.text, onCommit, { finishes: finishesText });

  const { zoom } = viewport;
  const position = toScreen(viewport, element.x1, element.y1);
  const { width, height } = measureText(element, value || " ");

  return (
    <textarea
      {...inputProps}
      wrap="off"
      aria-label="Text"
      className="canvas-ink absolute z-10 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 whitespace-pre outline-none"
      style={{
        left: position.x,
        top: position.y,
        width: (width + element.fontSize) * zoom,
        height: height * zoom,
        font: fontFor(element, zoom),
        lineHeight: LINE_HEIGHT,
        color: element.stroke,
        caretColor: element.stroke,
        // Turned text is edited turned, about the middle of the text itself.
        transform: element.angle ? `rotate(${element.angle}rad)` : undefined,
        transformOrigin: `${(width * zoom) / 2}px ${(height * zoom) / 2}px`,
      }}
    />
  );
}

/** What the note editor takes: the sticky note being edited. */
export type NoteEditorProps = EditorProps & { element: StickyElement };

/**
 * Edits a sticky note's text in place: the note itself, with its text wrapped
 * and sized as the canvas will draw it (see notes.js).
 */
export function NoteEditor({ element, viewport, onCommit }: NoteEditorProps) {
  const { value, inputProps } = useInlineEditor(element.text, onCommit, { finishes: finishesText });

  const { zoom } = viewport;
  const box = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  const position = toScreen(viewport, box.x, box.y);
  const layout = useMemo(() => noteLayout({ ...element, text: value }), [element, value]);

  return (
    <div
      className="canvas-ink absolute z-10 grid place-items-center shadow-md"
      style={{
        left: position.x,
        top: position.y,
        width: box.width * zoom,
        height: box.height * zoom,
        backgroundColor: element.fill,
        transform: element.angle ? `rotate(${element.angle}rad)` : undefined,
      }}
    >
      <textarea
        {...inputProps}
        aria-label="Sticky note text"
        // Words break between letters when they're too long for a line, as on the canvas. Text that doesn't fit
        // scrolls (without a scroll bar) so the caret stays in view, instead of running out of the note.
        className="m-0 block resize-none overflow-x-hidden overflow-y-auto border-0 bg-transparent p-0 text-center whitespace-pre-wrap [overflow-wrap:anywhere] [scrollbar-width:none] outline-none [&::-webkit-scrollbar]:hidden"
        style={{
          width: layout.width * zoom,
          height: Math.min(layout.lines.length * layout.lineHeight, layout.height) * zoom,
          // Separate properties, not the `font` shorthand: the size changes as the text grows.
          fontFamily: FONTS[fontKey(element.font)].family,
          fontSize: layout.fontSize * zoom,
          lineHeight: LINE_HEIGHT,
          color: NOTE_TEXT_COLOR,
          caretColor: NOTE_TEXT_COLOR,
        }}
      />
    </div>
  );
}

/** What the label editor takes: the line or arrow being labelled, and the point halfway along it. */
export type LabelEditorProps = EditorProps & { element: Connector; middle: XY };

/**
 * Edits a line's or arrow's label in place, centred on `middle` (halfway along
 * the connector, in board units), as the canvas will draw it.
 */
export function LabelEditor({ element, middle, viewport, onCommit }: LabelEditorProps) {
  const { value, inputProps } = useInlineEditor(element.text ?? "", onCommit, {
    finishes: finishesLabel,
    selectAll: true,
  });

  const { zoom } = viewport;
  const style = { fontSize: LABEL_FONT_SIZE, font: element.font };
  const { width, height } = measureText(style, value || " ");
  const center = toScreen(viewport, middle.x, middle.y);
  const boxWidth = (width + LABEL_FONT_SIZE) * zoom;
  const boxHeight = height * zoom;

  return (
    <textarea
      {...inputProps}
      wrap="off"
      aria-label="Label"
      placeholder="Label"
      className="canvas-ink absolute z-10 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-center whitespace-pre outline-none"
      style={{
        left: center.x - boxWidth / 2,
        top: center.y - boxHeight / 2,
        width: boxWidth,
        height: boxHeight,
        font: fontFor(style, zoom),
        lineHeight: LINE_HEIGHT,
        color: element.stroke,
        caretColor: element.stroke,
      }}
    />
  );
}
