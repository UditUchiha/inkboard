import { ApiElementError, fromApiElement } from "@inkboard/shared/api-elements";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { getBounds } from "../elements/elements";
import { readStatements } from "./common";
import type { Measure } from "./common";
import { layoutFlowchart, parseFlowchart } from "./flowchart";
import type { Flowchart } from "./flowchart";
import { SEQUENCE_HEADER, layoutSequence, parseSequence } from "./sequence";
import type { SequenceDiagram } from "./sequence";

// Flowcharts and sequence diagrams, both ways. Parsed here, not by Mermaid's library: it is megabytes and renders HTML.

export function describeSkipped(skipped: string[]): string {
  const shown = skipped.slice(0, 3).map((line) => `“${line.length > 40 ? `${line.slice(0, 39)}…` : line}”`);
  const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
  return `${skipped.length} ${skipped.length === 1 ? "line" : "lines"} of it couldn't be read: ${shown.join(", ")}${more}`;
}

export function mermaidToElements(text: string, centre: { x: number; y: number }, measure?: Measure) {
  // Ids of their own on every import, so importing twice adds a second copy rather than changing the first.
  const prefix = `mm${[...crypto.getRandomValues(new Uint32Array(1))][0].toString(36)}-`;
  const sequence = SEQUENCE_HEADER.test(readStatements(text)[0] ?? "");
  const chart = sequence ? parseSequence(text) : parseFlowchart(text);
  const laidOut = sequence
    ? layoutSequence(chart as SequenceDiagram, prefix, measure)
    : layoutFlowchart(chart as Flowchart, prefix, measure);
  const made = new Map<string, BoardElement>();
  for (const input of laidOut) {
    try {
      const element = fromApiElement(input, undefined, (elementId) => made.get(elementId), "Element");
      made.set(element.id, element);
    } catch (error) {
      if (!(error instanceof ApiElementError)) throw error;
    }
  }
  const elements = [...made.values()];
  const bounds = elements.map(getBounds);
  const middleX = (Math.min(...bounds.map((b) => b.x)) + Math.max(...bounds.map((b) => b.x + b.width))) / 2;
  const middleY = (Math.min(...bounds.map((b) => b.y)) + Math.max(...bounds.map((b) => b.y + b.height))) / 2;
  const [dx, dy] = [centre.x - middleX, centre.y - middleY];
  return { elements: elements.map((element) => shift(element, dx, dy)), skipped: chart.skipped };
}

function shift(element: BoardElement, dx: number, dy: number): BoardElement {
  const moved = { ...element } as Record<string, unknown>;
  for (const key of ["x1", "x2"]) if (typeof moved[key] === "number") moved[key] = (moved[key] as number) + dx;
  for (const key of ["y1", "y2"]) if (typeof moved[key] === "number") moved[key] = (moved[key] as number) + dy;
  return moved as BoardElement;
}
