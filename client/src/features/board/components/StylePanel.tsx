import clsx from "clsx";
import { Sigma } from "lucide-react";
import type { Element as BoardElement, ElementType, FrameElement, StackMove } from "@inkboard/shared/types";
import type { Dispatch, SetStateAction } from "react";
import { toast } from "sonner";
import { DRAWING_TOOLS } from "../constants/board";
import type { Style, ToolId } from "../constants/board";
import { CLASSROOM_TOAST, KEEP_INSIDE } from "../constants/editor";
import { staysInside } from "../lib/elements/classroom";
import type { Zone } from "../lib/elements/classroom";
import type { BoardStore } from "../lib/sync/store";
import type { BoardSync } from "../hooks/useBoardSync";
import { FrameClassroom } from "./ClassroomPanels";
import { PropertiesPanel } from "./PropertiesPanel";
import type { StyleChange } from "./PropertiesPanel";

// The cast: DRAWING_TOOLS holds only tools that are also the type of the element they draw.
export function styleTarget(tool: ToolId, selected: BoardElement | null): ElementType | null {
  if (tool === "select") return selected?.type ?? null;
  return DRAWING_TOOLS.has(tool) ? (tool as ElementType) : null;
}

export interface StylePanelProps {
  store: BoardStore;
  type: ElementType;
  tool: ToolId;
  style: Style;
  setStyle: Dispatch<SetStateAction<Style>>;
  selected: BoardElement | null;
  zone: Zone;
  open: boolean;
  stackMoves: Partial<Record<StackMove, boolean>>;
  cropping: boolean;
  onToggleCrop: () => void;
  onUncrop: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (where: StackMove) => void;
  onConvertToEquation: () => void;
  isMember: boolean;
  local: boolean;
  classroom: BoardSync["classroom"];
  onReleaseFrame: (frameId: string) => void;
  onCopyFrame: (frame: FrameElement, count: number) => void;
}

export function StylePanel({
  store,
  type,
  tool,
  style,
  setStyle,
  selected,
  zone,
  open,
  stackMoves,
  cropping,
  onToggleCrop,
  onUncrop,
  onDuplicate,
  onDelete,
  onMove,
  onConvertToEquation,
  isMember,
  local,
  classroom,
  onReleaseFrame,
  onCopyFrame,
}: StylePanelProps) {
  function changeStyle(key: StyleChange[0], value: StyleChange[1]) {
    // A note's color is its fill, but new notes keep their own color, apart from new shapes' fill.
    const styleKey = type === "sticky" && key === "fill" ? "noteFill" : key;
    if (key !== "name" && key !== "alt") setStyle((current) => ({ ...current, [styleKey]: value }));
    if (selected) {
      if (!staysInside({ ...selected, [key]: value } as BoardElement, zone)) {
        toast(KEEP_INSIDE, { id: CLASSROOM_TOAST });
        return;
      }
      store.commit(
        { undo: { upsert: [selected] }, redo: { upsert: [{ ...selected, [key]: value }] } },
        { mergeKey: `style:${selected.id}:${key}` },
      );
    }
  }

  return (
    <div className={clsx("absolute left-3 max-md:bottom-[7.5rem] md:top-20", !open && "max-md:hidden")}>
      <PropertiesPanel
        type={type}
        values={selected ?? (type === "sticky" ? { ...style, fill: style.noteFill } : style)}
        onChange={changeStyle}
        selection={Boolean(selected && tool === "select")}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        stackMoves={stackMoves}
        onMove={onMove}
        cropping={cropping}
        onToggleCrop={onToggleCrop}
        onUncrop={onUncrop}
      >
        {(selected?.type === "pen" || selected?.type === "frame") && tool === "select" && (
          <button
            type="button"
            onClick={onConvertToEquation}
            className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-rule text-xs font-medium hover:bg-surface-2"
          >
            <Sigma className="size-3.5" aria-hidden /> Convert to equation
          </button>
        )}
        {isMember && !local && selected?.type === "frame" && tool === "select" && (
          <FrameClassroom
            claimedBy={classroom?.claims.find((claim) => claim.frameId === selected.id)?.name ?? null}
            onRelease={() => onReleaseFrame(selected.id)}
            onCopy={(count) => onCopyFrame(selected, count)}
          />
        )}
      </PropertiesPanel>
    </div>
  );
}
