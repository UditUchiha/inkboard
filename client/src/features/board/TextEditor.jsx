import { useEffect, useMemo, useRef, useState } from "react";
import { FONTS, LABEL_FONT_SIZE, LINE_HEIGHT, NOTE_TEXT_COLOR } from "./constants";
import { fontFor, measureText } from "./elements";
import { normalizeRect, toScreen } from "./geometry";
import { noteLayout } from "./notes";

export function TextEditor({ element, viewport, onCommit }) {
  const ref = useRef(null);
  const committed = useRef(false);
  const [value, setValue] = useState(element.text);

  useEffect(() => {
    // Deferred so the click that opened the editor doesn't immediately blur it.
    const timer = setTimeout(() => {
      const textarea = ref.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(value);
  };

  const { zoom } = viewport;
  const position = toScreen(viewport, element.x1, element.y1);
  const { width, height } = measureText(element, value || " ");

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      wrap="off"
      spellCheck={false}
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

/**
 * Edits a sticky note's text in place: the note itself, with its text wrapped
 * and sized as the canvas will draw it (see notes.js).
 */
export function NoteEditor({ element, viewport, onCommit }) {
  const ref = useRef(null);
  const committed = useRef(false);
  const [value, setValue] = useState(element.text);

  useEffect(() => {
    const timer = setTimeout(() => {
      const textarea = ref.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(value);
  };

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
        ref={ref}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        spellCheck={false}
        aria-label="Sticky note text"
        className="m-0 block resize-none overflow-hidden border-0 bg-transparent p-0 text-center break-words whitespace-pre-wrap outline-none"
        style={{
          width: layout.width * zoom,
          height: Math.min(layout.lines.length * layout.lineHeight, layout.height) * zoom,
          // Separate properties, not the `font` shorthand: the size changes as the text grows.
          fontFamily: (FONTS[element.font] ?? FONTS.hand).family,
          fontSize: layout.fontSize * zoom,
          lineHeight: LINE_HEIGHT,
          color: NOTE_TEXT_COLOR,
          caretColor: NOTE_TEXT_COLOR,
        }}
      />
    </div>
  );
}

/**
 * Edits a line's or arrow's label in place, centred on `middle` (halfway along
 * the connector, in board units), as the canvas will draw it.
 */
export function LabelEditor({ element, middle, viewport, onCommit }) {
  const ref = useRef(null);
  const committed = useRef(false);
  const [value, setValue] = useState(element.text ?? "");

  useEffect(() => {
    const timer = setTimeout(() => {
      const textarea = ref.current;
      if (!textarea) return;
      textarea.focus();
      textarea.select();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(value);
  };

  const { zoom } = viewport;
  const style = { fontSize: LABEL_FONT_SIZE, font: element.font };
  const { width, height } = measureText(style, value || " ");
  const center = toScreen(viewport, middle.x, middle.y);
  const boxWidth = (width + LABEL_FONT_SIZE) * zoom;
  const boxHeight = height * zoom;

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        // Enter finishes a label; Shift + Enter starts a new line in it.
        if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      wrap="off"
      spellCheck={false}
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
