import clsx from "clsx";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useElementSize } from "../../lib/useElementSize";
import { useTheme } from "../../providers/ThemeProvider";
import { getSceneBounds } from "./elements";
import { fitViewport } from "./geometry";
import { imageState, releaseImages, subscribeImages } from "./images";
import { loadCanvasFonts, renderScene } from "./renderer";

// Start drawing a little before a preview scrolls into view.
const VISIBLE_MARGIN = "200px";

/** A static, scaled-to-fit rendering of a board, used for thumbnails. */
export function BoardPreview({ elements, className, padding = 18, maxZoom = 1, children }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const size = useElementSize(containerRef);
  const [fontsReady, setFontsReady] = useState(false);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const { theme } = useTheme();

  // Previews far off screen (a long dashboard) are neither drawn nor download their pictures until they are near.
  useEffect(() => {
    if (visible) return undefined;
    const observer = new IntersectionObserver(
      (entries) => entries.some((entry) => entry.isIntersecting) && setVisible(true),
      { rootMargin: VISIBLE_MARGIN },
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    let active = true;
    loadCanvasFonts().then(() => active && setFontsReady(true));
    return () => {
      active = false;
    };
  }, []);

  // Redraw when one of this preview's own pictures finishes loading (or fails), not whenever any picture
  // anywhere does. Followed through the picture cache rather than each download, so a picture asked for
  // again (a retry, or one the cache dropped and the next drawing fetched anew) is redrawn when it comes too.
  const imageIds = useMemo(
    () => [...new Set(elements.filter((element) => element.type === "image").map((element) => element.imageId))],
    [elements],
  );
  const watching = visible && imageIds.length > 0;
  const subscribe = useCallback((listener) => (watching ? subscribeImages(listener) : () => {}), [watching]);
  const picturesLoaded = useSyncExternalStore(subscribe, () =>
    watching ? imageIds.map((imageId) => imageState(imageId, { small: true })).join() : "",
  );

  // The canvas is gone with the card, so the pictures it kept on show (see showingImages) are let go of.
  useEffect(() => {
    const canvas = canvasRef.current;
    return () => releaseImages(canvas);
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    const bounds = getSceneBounds(elements);
    const viewport = bounds ? fitViewport(bounds, size, { padding, maxZoom }) : { x: 0, y: 0, zoom: 1 };
    renderScene(canvas, { elements, viewport, dpr, dark: theme === "dark", smallImages: true });
  }, [visible, elements, size, padding, maxZoom, fontsReady, picturesLoaded, theme]);

  return (
    <div ref={containerRef} className={clsx("relative overflow-hidden", className)}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
      {children}
    </div>
  );
}
