import type { Element as BoardElement } from "@inkboard/shared/types";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useElementSize } from "../../../hooks/useElementSize";
import { useTheme } from "../../../providers/ThemeProvider";
import { GRID_SIZE } from "../constants/board";
import type { Style, ToolId } from "../constants/board";
import type { TextEdit } from "../constants/editor";
import type { Zone } from "../lib/elements/classroom";
import type { AnyElement } from "../lib/elements/elements";
import type { Size, Viewport, XY } from "../lib/elements/geometry";
import { imagesVersion, subscribeImages } from "../lib/files/images";
import { loadCanvasFonts, renderScene } from "../lib/render/renderer";
import { createTileCache } from "../lib/render/zoomedOutCache";
import type { TileCache } from "../lib/render/zoomedOutCache";
import { useBoardSnapshot } from "../lib/sync/store";
import type { BoardStore } from "../lib/sync/store";
import type { SuggestionMark } from "../lib/sync/suggestions";
import { cursorForHandle } from "../lib/elements/transform";
import { useCanvasPointer } from "../hooks/useCanvasPointer";
import { useCanvasZoom } from "../hooks/useCanvasZoom";

const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="9" fill="white" fill-opacity=".6" stroke="#16213a" stroke-width="1.5"/></svg>',
)}") 11 11, crosshair`;

function useCanvasFontsReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    loadCanvasFonts().then(() => active && setReady(true));
    return () => {
      active = false;
    };
  }, []);
  return ready;
}

// Grid cells shrink with zoom; jump to the next coarser grid when they get tiny.
function gridStyle(viewport: Viewport) {
  let cell = GRID_SIZE * viewport.zoom;
  while (cell < 10) cell *= 5;
  return {
    "--cell": `${cell}px`,
    backgroundPosition: `${viewport.x * viewport.zoom}px ${viewport.y * viewport.zoom}px`,
  };
}

export interface BoardCanvasProps {
  store: BoardStore;
  tool: ToolId;
  style: Style;
  viewport: Viewport;
  onViewportChange: (next: Viewport | ((current: Viewport) => Viewport)) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  // Outlined while connecting from the keyboard (see BoardEditor).
  connectTargetId?: string | undefined;
  // Left out of the drawing while its text is edited.
  editingId?: string | undefined;
  onEditText: (edit: TextEdit) => void;
  spacePressed: boolean;
  onCursorMove: (point: XY | null) => void;
  onSizeChange?: (size: Size) => void;
  onPlaceComment?: (point: XY) => void;
  onVote?: (point: XY, hit: BoardElement | null) => void;
  onFrameDrawn?: (id: string) => void;
  suggestions?: readonly SuggestionMark[];
  croppingId?: string | null;
  // Classroom mode: where this person may change things (see classroom.ts), and what to do on pressing elsewhere.
  zone?: Zone;
  onOutsideZone?: (point: XY) => void;
  frameClaims?: ReadonlyMap<string, { name: string; mine: boolean }>;
}

const NO_MARKS: readonly SuggestionMark[] = [];

export function BoardCanvas({
  store,
  tool,
  style,
  viewport,
  onViewportChange,
  selectedId,
  onSelect,
  connectTargetId,
  editingId,
  onEditText,
  spacePressed,
  onCursorMove,
  onSizeChange,
  onPlaceComment,
  onVote,
  onFrameDrawn,
  suggestions = NO_MARKS,
  croppingId = null,
  zone,
  onOutsideZone,
  frameClaims,
}: BoardCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useElementSize(containerRef);
  const fontsReady = useCanvasFontsReady();
  const picturesLoaded = useSyncExternalStore(subscribeImages, imagesVersion);
  const { theme } = useTheme();
  const { elements } = useBoardSnapshot(store);
  // Zoomed-out drawing is kept as pictures that hold memory until closed.
  const [tiles] = useState((): TileCache => createTileCache((tile) => tile.bitmap.close()));
  useEffect(() => () => tiles.clear(), [tiles]);

  const { panning, hovering, handle, turning, hint, latest, handlers } = useCanvasPointer({
    store,
    canvasRef,
    tool,
    style,
    viewport,
    spacePressed,
    editingId,
    selectedId,
    croppingId,
    zone,
    onViewportChange,
    onSelect,
    onEditText,
    onCursorMove,
    onPlaceComment,
    onVote,
    onFrameDrawn,
    onOutsideZone,
  });
  useCanvasZoom(canvasRef, containerRef, latest, onViewportChange);

  useEffect(() => {
    onSizeChange?.(size);
  }, [size, onSizeChange]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(size.width * dpr);
    const height = Math.round(size.height * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    renderScene(canvas, {
      elements,
      viewport,
      dpr,
      selectedId,
      hiddenId: editingId,
      dark: theme === "dark",
      screenLabels: true,
      connectTargetId: connectTargetId ?? hint.outline,
      dots: hint.dots,
      suggestions,
      croppingId,
      frameClaims,
      tiles,
    });
  }, [
    elements,
    viewport,
    size,
    selectedId,
    editingId,
    fontsReady,
    picturesLoaded,
    theme,
    hint,
    connectTargetId,
    suggestions,
    croppingId,
    frameClaims,
    tiles,
  ]);

  let cursor = "crosshair";
  if (panning) cursor = "grabbing";
  else if (spacePressed || tool === "hand") cursor = "grab";
  else if (tool === "select" && handle) {
    const selected: AnyElement | null | undefined = selectedId ? store.getElement(selectedId) : null;
    cursor = turning ? "grabbing" : cursorForHandle(handle, selected?.angle ?? 0);
  } else if (tool === "select" && hint.dots?.side) cursor = "crosshair";
  else if (tool === "select") cursor = hovering ? "move" : "default";
  else if (tool === "text") cursor = "text";
  else if (tool === "comment") cursor = "copy";
  else if (tool === "vote") cursor = "pointer";
  else if (tool === "eraser") cursor = ERASER_CURSOR;

  return (
    <div ref={containerRef} className="graph-paper absolute inset-0" style={gridStyle(viewport)}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        style={{ cursor }}
        {...handlers}
        onMouseDown={(event) => event.preventDefault()}
        aria-label="Drawing canvas"
      />
    </div>
  );
}
