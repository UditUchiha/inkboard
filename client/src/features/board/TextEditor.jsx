import { useEffect, useRef, useState } from "react";
import { LINE_HEIGHT } from "./constants";
import { fontFor, measureText } from "./elements";
import { toScreen } from "./geometry";

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
