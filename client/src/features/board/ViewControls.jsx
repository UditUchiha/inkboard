import { Maximize, Minus, Palette, Plus, Redo2, Undo2 } from "lucide-react";
import { IconButton } from "../../components/Button";

/** Bottom left: undo and redo, zoom, and (on phones) the button that opens the style panel. */
export function ViewControls({
  store,
  readOnly,
  canUndo,
  canRedo,
  zoom,
  canFit,
  onZoomBy,
  onResetZoom,
  onFit,
  showStyleButton,
  styleOpen,
  onToggleStyle,
}) {
  return (
    <div className="absolute bottom-[4.25rem] left-3 flex items-center gap-2 md:bottom-3">
      {!readOnly && (
        <div className="floating-panel flex items-center rounded-xl p-1">
          <IconButton label="Undo" icon={Undo2} onClick={store.undo} disabled={!canUndo} />
          <IconButton label="Redo" icon={Redo2} onClick={store.redo} disabled={!canRedo} />
        </div>
      )}
      <div className="floating-panel flex items-center rounded-xl p-1 max-sm:hidden">
        <IconButton label="Zoom out" icon={Minus} onClick={() => onZoomBy(0.8)} />
        <button
          type="button"
          onClick={onResetZoom}
          title="Reset zoom"
          className="h-10 min-w-14 rounded-lg px-1 text-sm font-medium tabular-nums transition-colors hover:bg-ink/6"
        >
          {Math.round(zoom * 100)}%
        </button>
        <IconButton label="Zoom in" icon={Plus} onClick={() => onZoomBy(1.25)} />
        <IconButton label="Fit drawing to screen" icon={Maximize} onClick={onFit} disabled={!canFit} />
      </div>
      {showStyleButton && (
        <div className="floating-panel rounded-xl p-1 md:hidden">
          <IconButton label="Style" icon={Palette} active={styleOpen} onClick={onToggleStyle} />
        </div>
      )}
    </div>
  );
}
