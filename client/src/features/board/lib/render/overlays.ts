import type { Element as BoardElement, Side } from "@inkboard/shared/types";
import { connectionDots } from "../elements/connectors";
import { getBounds, getFrame } from "../elements/elements";
import type { AnyElement } from "../elements/elements";
import { expandRect, polygonCorners } from "../elements/geometry";
import type { Rect } from "../elements/geometry";
import { getSelectionBox } from "../elements/transform";
import type { Ink } from "./ink";
import type { RenderOptions } from "./renderer";

export const SELECTION_COLOR = "#2d5bff";
const HANDLE_SIZE = 9; // screen pixels

export function drawSelection(ctx: CanvasRenderingContext2D, element: BoardElement, zoom: number, paint: Ink) {
  const selection = getSelectionBox(element, zoom);
  ctx.save();
  ctx.strokeStyle = paint(SELECTION_COLOR);
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([5 / zoom, 4 / zoom]);

  if (selection.kind === "box") {
    const { frame, halfWidth, halfHeight } = selection;
    ctx.save();
    ctx.translate(frame.cx, frame.cy);
    ctx.rotate(frame.angle);
    ctx.strokeRect(-halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2);
    ctx.restore();

    const turn = selection.handles.find((handle) => handle.id === "rotate");
    if (turn) {
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(selection.top.x, selection.top.y);
      ctx.lineTo(turn.x, turn.y);
      ctx.stroke();
    }
  } else {
    const bounds = expandRect(getBounds(element), 6 / zoom);
    ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  ctx.setLineDash([]);
  ctx.fillStyle = paint("#ffffff");
  const size = HANDLE_SIZE / zoom;
  for (const handle of selection.handles) {
    ctx.beginPath();
    if (handle.id === "rotate") ctx.arc(handle.x, handle.y, size / 2 + 0.5 / zoom, 0, Math.PI * 2);
    else ctx.rect(handle.x - size / 2, handle.y - size / 2, size, size);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawConnectTarget(ctx: CanvasRenderingContext2D, element: AnyElement, zoom: number, paint: Ink) {
  const { cx, cy, width, height, angle } = getFrame(element);
  const pad = 4 / zoom + (element.strokeWidth ?? 0) / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.strokeStyle = paint(SELECTION_COLOR);
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 2.5 / zoom;
  ctx.beginPath();
  const box = { x: -width / 2 - pad, y: -height / 2 - pad, width: width + pad * 2, height: height + pad * 2 };
  const corners = polygonCorners(element.type, box);
  if (element.type === "ellipse") ctx.ellipse(0, 0, box.width / 2, box.height / 2, 0, 0, Math.PI * 2);
  else if (corners) for (const [x, y] of corners) ctx.lineTo(x, y);
  else ctx.rect(box.x, box.y, box.width, box.height);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawConnectionDots(
  ctx: CanvasRenderingContext2D,
  element: AnyElement,
  zoom: number,
  side: Side | null,
  paint: Ink,
) {
  ctx.save();
  ctx.strokeStyle = paint(SELECTION_COLOR);
  ctx.lineWidth = 1.5 / zoom;
  for (const [each, dot] of Object.entries(connectionDots(element, zoom))) {
    const active = each === side;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, (active ? 6 : 4.5) / zoom, 0, Math.PI * 2);
    ctx.fillStyle = active ? paint(SELECTION_COLOR) : paint("#ffffff");
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export function hatch(ctx: CanvasRenderingContext2D, box: Rect, zoom: number, opacity: number) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  ctx.globalAlpha = opacity;
  ctx.lineWidth = 1.5 / zoom;
  ctx.beginPath();
  for (let offset = -box.height; offset < box.width; offset += 10 / zoom) {
    ctx.moveTo(box.x + offset, box.y + box.height);
    ctx.lineTo(box.x + offset + box.height, box.y);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawMarks(
  ctx: CanvasRenderingContext2D,
  { target, dotted, selected }: Record<"target" | "dotted" | "selected", BoardElement | null>,
  { viewport, dots = null, hiddenId }: RenderOptions,
  paint: Ink,
) {
  if (target) drawConnectTarget(ctx, target, viewport.zoom, paint);
  if (dotted) drawConnectionDots(ctx, dotted, viewport.zoom, dots!.side, paint);
  if (selected && selected.id !== hiddenId) drawSelection(ctx, selected, viewport.zoom, paint);
}
