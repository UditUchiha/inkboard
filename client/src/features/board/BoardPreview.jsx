import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useElementSize } from "../../lib/useElementSize";
import { getSceneBounds } from "./elements";
import { fitViewport } from "./geometry";
import { loadCanvasFonts, renderScene } from "./renderer";

/** A static, scaled-to-fit rendering of a board, used for thumbnails. */
export function BoardPreview({ elements, className, padding = 18, maxZoom = 1, children }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const size = useElementSize(containerRef);
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    let active = true;
    loadCanvasFonts().then(() => active && setFontsReady(true));
    return () => {
      active = false;
    };
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    const bounds = getSceneBounds(elements);
    const viewport = bounds ? fitViewport(bounds, size, { padding, maxZoom }) : { x: 0, y: 0, zoom: 1 };
    renderScene(canvas, { elements, viewport, dpr });
  }, [elements, size, padding, maxZoom, fontsReady]);

  return (
    <div ref={containerRef} className={clsx("relative overflow-hidden", className)}>
      <canvas ref={canvasRef} className="canvas-ink absolute inset-0 h-full w-full" aria-hidden />
      {children}
    </div>
  );
}
