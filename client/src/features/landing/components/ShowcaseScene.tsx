import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useElementSize } from "../../../hooks/useElementSize";
import { formulaOf, onFormulasChanged } from "../../board/lib/elements/math";
import { loadCanvasFonts, renderScene } from "../../board/lib/render/renderer";
import { HOLD_MS, loopTime, SHOW_HEIGHT, SHOW_WIDTH, stateAt } from "../lib/showcase";
import type { Scene } from "../lib/showcase";
import { SceneCursor } from "./SceneCursor";

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface ShowcaseSceneProps {
  scene: Scene;
  label: string;
}

// Plays a scene on a loop while it's on screen; with reduced motion it shows the finished board instead.
export function ShowcaseScene({ scene, label }: ShowcaseSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useElementSize(containerRef);
  const [fontsReady, setFontsReady] = useState(false);
  const [inView, setInView] = useState(false);
  const [time, setTime] = useState(() => (prefersReducedMotion() ? scene.duration : 0));
  const [formulasVersion, formulasChanged] = useReducer((n: number) => n + 1, 0);

  const scale = size.width / SHOW_WIDTH;
  const state = useMemo(() => stateAt(scene, time), [scene, time]);

  useEffect(() => {
    let active = true;
    loadCanvasFonts().then(() => active && setFontsReady(true));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => onFormulasChanged(formulasChanged), []);

  // MathJax loads on first use, so a formula the scene ends on is typeset while the scene plays, not when it appears.
  useEffect(() => {
    if (!inView) return;
    for (const element of stateAt(scene, scene.duration).elements) {
      if (element.type === "text") formulaOf(element.text);
    }
  }, [inView, scene]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.3 });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inView || prefersReducedMotion()) return undefined;
    let frame: number;
    const start = performance.now();
    const tick = (now: number) => {
      setTime(loopTime(scene, now - start));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, scene]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    renderScene(canvas, {
      elements: state.elements,
      suggestions: state.suggestions,
      frameClaims: state.claims,
      viewport: { x: 0, y: 0, zoom: scale },
      dpr,
    });
  }, [size, scale, state, fontsReady, formulasVersion]);

  const holding = time >= scene.duration && time < scene.duration + HOLD_MS;

  return (
    <div
      ref={containerRef}
      className="graph-paper relative overflow-hidden rounded-xl border border-rule [--cell:20px]"
      style={{ aspectRatio: `${SHOW_WIDTH} / ${SHOW_HEIGHT}` }}
    >
      <canvas ref={canvasRef} className="canvas-ink absolute inset-0 h-full w-full" role="img" aria-label={label} />
      {size.width > 0 && (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {state.cursors.map((cursor) => (
            <SceneCursor
              key={cursor.by.name}
              person={cursor.by}
              x={cursor.x}
              y={cursor.y}
              scale={scale}
              glide={holding || !state.elements.some((element) => element.type === "pen")}
            />
          ))}
          {state.note && (
            <p
              key={state.note}
              className="floating-panel rise-in absolute bottom-3 left-3 max-w-[85%] rounded-full px-3 py-1.5 text-sm font-medium"
            >
              {state.note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
