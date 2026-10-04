import { RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useElementSize } from "../../lib/useElementSize";
import { createElement } from "../board/elements";
import { loadCanvasFonts, renderScene } from "../board/renderer";
import { RemoteCursorArrow } from "../board/RemoteCursors";
import { circleStroke, COLLABORATORS, DEMO_ELEMENTS, SCENE_HEIGHT, SCENE_WIDTH } from "./demoScene";

const [MAYA, SAM] = COLLABORATORS;
const LOOP = circleStroke();
const DRAW_DELAY_MS = 900;
const DRAW_DURATION_MS = 2200;
const VISITOR_STYLE = { stroke: "#16213a", penSize: 6 };

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function loopElement(count) {
  return { id: "maya-loop", type: "pen", pressure: false, stroke: "#e03131", penSize: 5, points: LOOP.slice(0, count) };
}

function Cursor({ person, x, y, scale, glide = false }) {
  return (
    <div
      className={glide ? "absolute top-0 left-0 transition-transform duration-1000 ease-out" : "absolute top-0 left-0"}
      style={{ transform: `translate(${x * scale}px, ${y * scale}px)` }}
    >
      <RemoteCursorArrow color={person.color} />
      <span
        className="absolute top-5 left-3.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-white"
        style={{ backgroundColor: person.color }}
      >
        {person.name}
      </span>
    </div>
  );
}

/**
 * The landing page's live board: a pre-drawn sketch, a collaborator who
 * circles part of it, and a pen the visitor can draw with.
 */
export function DemoBoard() {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const size = useElementSize(containerRef);
  const [fontsReady, setFontsReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [doodles, setDoodles] = useState([]);
  const drawing = useRef(null);

  const scale = size.width / SCENE_WIDTH;

  useEffect(() => {
    let active = true;
    loadCanvasFonts().then(() => active && setFontsReady(true));
    return () => {
      active = false;
    };
  }, []);

  // One orchestrated moment: Maya draws a loop around "Ship it".
  useEffect(() => {
    if (prefersReducedMotion()) {
      setProgress(1);
      return undefined;
    }
    let frame;
    let start;
    const tick = (now) => {
      start ??= now;
      const t = Math.min(1, Math.max(0, (now - start - DRAW_DELAY_MS) / DRAW_DURATION_MS));
      setProgress(1 - (1 - t) ** 2);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const loopCount = Math.max(1, Math.round(progress * LOOP.length));

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    const elements = [...DEMO_ELEMENTS, ...(progress > 0 ? [loopElement(loopCount)] : []), ...doodles];
    renderScene(canvas, { elements, viewport: { x: 0, y: 0, zoom: scale }, dpr });
  }, [size, scale, loopCount, progress, doodles, fontsReady]);

  const toScene = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };

  function onPointerDown(event) {
    if (event.button !== 0) return;
    canvasRef.current.setPointerCapture(event.pointerId);
    const element = createElement("pen", toScene(event), VISITOR_STYLE);
    drawing.current = element.id;
    setDoodles((current) => [...current, element]);
  }

  function onPointerMove(event) {
    if (!drawing.current) return;
    const { x, y } = toScene(event);
    setDoodles((current) =>
      current.map((element) =>
        element.id === drawing.current ? { ...element, points: [...element.points, [x, y, 0.5]] } : element,
      ),
    );
  }

  const stopDrawing = () => {
    drawing.current = null;
  };

  const tip = LOOP[loopCount - 1];
  const mayaAt = progress < 1 ? { x: tip[0] + 4, y: tip[1] + 2 } : { x: 520, y: 360 };

  return (
    <figure className="m-0">
      <div
        ref={containerRef}
        className="graph-paper relative overflow-hidden rounded-xl border border-rule [--cell:20px]"
        style={{ aspectRatio: `${SCENE_WIDTH} / ${SCENE_HEIGHT}` }}
      >
        <canvas
          ref={canvasRef}
          className="canvas-ink absolute inset-0 h-full w-full cursor-crosshair touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={stopDrawing}
          onPointerCancel={stopDrawing}
          aria-label="Sample board you can draw on"
        />
        {size.width > 0 && (
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            {progress > 0 && (
              <Cursor person={MAYA} x={mayaAt.x} y={mayaAt.y} scale={scale} glide={progress === 1} />
            )}
            <Cursor person={SAM} x={SAM.rest.x} y={SAM.rest.y} scale={scale} />
          </div>
        )}
      </div>
      <figcaption className="mt-3 flex items-center justify-between gap-3 text-sm text-graphite">
        <span>This board is live. Draw anywhere on it.</span>
        {doodles.length > 0 && (
          <button
            type="button"
            onClick={() => setDoodles([])}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-ink hover:bg-ink/6"
          >
            <RotateCcw className="size-3.5" aria-hidden /> Clear my drawing
          </button>
        )}
      </figcaption>
    </figure>
  );
}
