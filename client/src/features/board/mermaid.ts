import { ApiElementError, fromApiElement } from "@inkboard/shared/api-elements";
import type { ApiElement } from "@inkboard/shared/api-elements";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { getBounds, isFrame } from "./elements";
import { rectContains } from "./geometry";
import type { Rect } from "./geometry";

// Mermaid flowcharts (https://mermaid.js.org/syntax/flowchart.html), both ways: imported as shapes, labels, arrows
// and frames laid out on the board, and a drawn diagram exported as one. Only flowcharts (`flowchart` and `graph`)
// are read: they're what boards draw. The text is parsed here rather than by Mermaid's own library, which is
// megabytes and renders HTML; nothing in it is ever rendered as HTML here.

type Direction = "TD" | "LR" | "BT" | "RL";
type NodeShape = "rectangle" | "ellipse" | "diamond";
type Node = { id: string; label: string; shape: NodeShape; fill?: string };
type Edge = { from: string; to: string; label: string; head: "none" | "end" | "both" };
type Subgraph = { id: string; title: string; nodes: Set<string>; parent: Subgraph | null };

/** A flowchart as read from Mermaid: its direction, nodes, edges and subgraphs, and how many lines weren't understood. */
export type Flowchart = {
  direction: Direction;
  nodes: Map<string, Node>;
  edges: Edge[];
  subgraphs: Subgraph[];
  skipped: number;
};

/** Why Mermaid text can't be imported, in a sentence for the person. */
export class MermaidError extends Error {}

const MAX_NODES = 500;
// Longer statements are left out (and counted): the patterns below take a long time on very long lines.
const MAX_STATEMENT_LENGTH = 1000;

// Openings of a node's shape, longest first, with how each closes and what it's drawn as.
const SHAPES: [open: string, close: string, shape: NodeShape][] = [
  ["(((", ")))", "ellipse"],
  ["((", "))", "ellipse"],
  ["([", "])", "ellipse"],
  ["[[", "]]", "rectangle"],
  ["[(", ")]", "rectangle"],
  ["[/", "/]", "rectangle"],
  ["[\\", "\\]", "rectangle"],
  ["[/", "\\]", "rectangle"],
  ["[\\", "/]", "rectangle"],
  ["{{", "}}", "diamond"],
  ["(", ")", "rectangle"],
  ["[", "]", "rectangle"],
  ["{", "}", "diamond"],
  [">", "]", "rectangle"],
];

// A dash only carries an id on when a letter or digit follows, so `A-->B` is A, a link and B.
const NODE_ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_.:]|-(?=[\p{L}\p{N}_]))*/u;
// A link, with its text either in the middle (`-- text -->`) or after it (`-->|text|`). Longer and dotted or thick
// links draw the same; `o` and `x` ends draw as arrowheads.
const LINK =
  /^(<)?(?:(--|==|-\.)\s*([^|>]+?)\s*)?(-{2,}>|-{3,}|={2,}>|={3,}|-?\.+-+>|-?\.+-|--[ox]|==[ox])(?:\s*\|([^|]*)\|)?/;
const IGNORED = /^(classDef|class|linkStyle|click|accTitle|accDescr|direction)\b/;

// Text as Mermaid writes it: quoted, with line breaks as <br>, quotes as #quot;, and Markdown backticks.
function cleanLabel(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) text = text.slice(1, -1);
  if (text.startsWith("`") && text.endsWith("`") && text.length >= 2) text = text.slice(1, -1);
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#quot;/g, '"')
    .replace(/#35;/g, "#")
    .replace(/fa:fa-[\w-]+\s*/g, "")
    .trim();
}

// Splits text into statements: lines, and `;` between statements, but not inside quotes or brackets.
function statements(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') quoted = !quoted;
      else if (!quoted && "[({".includes(char)) depth += 1;
      else if (!quoted && "])}".includes(char)) depth = Math.max(0, depth - 1);
      else if (!quoted && depth === 0 && char === ";") {
        out.push(line.slice(start, i));
        start = i + 1;
      }
    }
    out.push(line.slice(start));
  }
  return out.map((statement) => statement.replace(/%%.*$/, "").trim()).filter(Boolean);
}

// One node at the start of `text`: its id and, if given, shape and label. Returns what's left of the text after it.
function readNode(text: string): { id: string; label?: string; shape?: NodeShape; rest: string } | null {
  const match = NODE_ID.exec(text);
  if (!match) return null;
  const id = match[0];
  let rest = text.slice(id.length);
  if (rest.startsWith("@{")) rest = rest.slice(rest.indexOf("}") + 1); // the newer shape syntax: kept as a box
  for (const [open, close, shape] of SHAPES) {
    if (!rest.startsWith(open)) continue;
    const body = rest.slice(open.length);
    // A quoted label may hold the closing brackets, so its end is looked for after the closing quote.
    const from = body.trimStart().startsWith('"') ? body.indexOf('"', body.indexOf('"') + 1) + 1 : 0;
    const end = body.indexOf(close, Math.max(0, from));
    if (end < 0) continue;
    return { id, label: cleanLabel(body.slice(0, end)), shape, rest: body.slice(end + close.length) };
  }
  return { id, rest };
}

// Nodes joined by `&` at the start of `text`.
function readNodes(text: string) {
  const nodes: NonNullable<ReturnType<typeof readNode>>[] = [];
  let rest = text;
  for (;;) {
    const node = readNode(rest.trimStart());
    if (!node) return null;
    nodes.push(node);
    rest = node.rest;
    const and = /^\s*&\s*/.exec(rest);
    if (!and) return { nodes, rest };
    rest = rest.slice(and[0].length);
  }
}

/** Reads a Mermaid flowchart. Throws a MermaidError when it isn't one. */
export function parseFlowchart(text: string): Flowchart {
  // Front matter (a title, a theme) comes first, between lines of three dashes.
  const lines = statements(text.replace(/^\s*---\r?\n[\s\S]*?\r?\n---[^\S\n]*(\r?\n|$)/, ""));
  const header = /^(flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*$/i.exec(lines[0] ?? "");
  if (!header) {
    throw new MermaidError(
      lines.length === 0
        ? "Paste a Mermaid flowchart to import."
        : "Only Mermaid flowcharts can be imported: ones that start with “flowchart” or “graph”.",
    );
  }
  const direction = (header[2] ?? "TD").toUpperCase().replace("TB", "TD") as Direction;
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const subgraphs: Subgraph[] = [];
  let open: Subgraph | null = null;
  let skipped = 0;

  const note = (found: NonNullable<ReturnType<typeof readNode>>) => {
    const known = nodes.get(found.id);
    const node = known ?? { id: found.id, label: found.id, shape: "rectangle" as NodeShape };
    if (found.label !== undefined) node.label = found.label;
    if (found.shape) node.shape = found.shape;
    if (!known) {
      if (nodes.size >= MAX_NODES) throw new MermaidError(`That's more than ${MAX_NODES} nodes, too many to import.`);
      nodes.set(found.id, node);
    }
    for (let group = open; group; group = group.parent) group.nodes.add(found.id);
  };

  for (const line of lines.slice(1)) {
    if (line.length > MAX_STATEMENT_LENGTH) {
      skipped += 1;
      continue;
    }
    const subgraph = /^subgraph\s+(.+)$/i.exec(line);
    if (subgraph) {
      const named = /^([^\s[]+)\s*\[(.*)\]$/.exec(subgraph[1].trim());
      const title = cleanLabel(named ? named[2] : subgraph[1]);
      open = { id: named ? named[1] : `subgraph${subgraphs.length + 1}`, title, nodes: new Set(), parent: open };
      subgraphs.push(open);
      continue;
    }
    if (/^end$/i.test(line)) {
      open = open?.parent ?? null;
      continue;
    }
    const style = /^style\s+(\S+)\s+(.*)$/i.exec(line);
    if (style) {
      const fill = /(?:^|,)\s*fill\s*:\s*(#[0-9a-f]{3,8})\b/i.exec(style[2]);
      const node = nodes.get(style[1]);
      if (fill && node) node.fill = fill[1];
      continue;
    }
    if (IGNORED.test(line)) continue;

    // A line's nodes and links are only kept once all of it is read: one that isn't Mermaid adds nothing.
    let read = readNodes(line);
    const found = read ? [...read.nodes] : [];
    const linked: Edge[] = [];
    let from = read?.nodes ?? [];
    let rest = read?.rest.trim() ?? "";
    while (read && rest) {
      const link = LINK.exec(rest);
      read = link && readNodes(rest.slice(link[0].length));
      if (!link || !read) break;
      const [, back, , middle, arrow, after] = link;
      const ends = /[>ox]$/.test(arrow);
      const head = back && ends ? "both" : ends ? "end" : "none";
      const label = cleanLabel(after ?? middle ?? "");
      for (const start of from) for (const end of read.nodes) linked.push({ from: start.id, to: end.id, label, head });
      found.push(...read.nodes);
      from = read.nodes;
      rest = read.rest.trim();
    }
    if (!read) {
      skipped += 1;
      continue;
    }
    found.forEach(note);
    edges.push(...linked);
  }
  if (nodes.size === 0) throw new MermaidError("That flowchart has no nodes to import.");
  return { direction, nodes, edges, subgraphs, skipped };
}

/** How big text is on the board, as `measureText` in elements.ts says; tests use an estimate. */
export type Measure = (text: string, fontSize: number) => { width: number; height: number };

const estimate: Measure = (text, fontSize) => {
  const lines = text.split("\n");
  return {
    width: Math.max(...lines.map((line) => line.length)) * fontSize * 0.55,
    height: lines.length * fontSize * 1.25,
  };
};

const FONT_SIZE = 20;
const RANK_GAP = 90;
const NODE_GAP = 60;
const FRAME_PADDING = 40;

// Every node's place, rank by rank: ranks follow the edges (longest path from where they start, edges that loop back
// ignored), and the nodes in each rank are ordered to sit near what leads to them.
function rankNodes({ nodes, edges, subgraphs }: Flowchart) {
  const ids = [...nodes.keys()];
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  for (const { from, to } of edges) if (from !== to) outgoing.get(from)!.push(to);
  // Edges that loop back (found depth-first) are left out of the ranking, so a cycle doesn't stretch forever.
  const forward = new Map(ids.map((id) => [id, [] as string[]]));
  const state = new Map<string, "open" | "done">();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const next of outgoing.get(id)!) {
      if (state.get(next) === "open") continue;
      forward.get(id)!.push(next);
      if (!state.has(next)) visit(next);
    }
    state.set(id, "done");
  };
  for (const id of ids) if (!state.has(id)) visit(id);

  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const targets of forward.values()) for (const to of targets) incoming.set(to, incoming.get(to)! + 1);
  const rank = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => incoming.get(id) === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const to of forward.get(id)!) {
      rank.set(to, Math.max(rank.get(to)!, rank.get(id)! + 1));
      incoming.set(to, incoming.get(to)! - 1);
      if (incoming.get(to) === 0) queue.push(to);
    }
  }

  const ranks: string[][] = [];
  for (const id of ids) (ranks[rank.get(id)!] ??= []).push(id);
  // Nodes of a subgraph kept together, then each ordered by where its predecessors are (two sweeps are plenty here).
  const group = new Map<string, number>();
  subgraphs.forEach((subgraph, index) => subgraph.nodes.forEach((id) => group.set(id, index)));
  const predecessors = new Map(ids.map((id) => [id, [] as string[]]));
  for (const [from, targets] of forward) for (const to of targets) predecessors.get(to)!.push(from);
  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (let r = 1; r < ranks.length; r += 1) {
      const place = new Map(ranks[r - 1].map((id, index) => [id, index]));
      const centre = (id: string, index: number) => {
        const known = predecessors.get(id)!.filter((from) => place.has(from));
        return known.length ? known.reduce((sum, from) => sum + place.get(from)!, 0) / known.length : index;
      };
      const keyed = ranks[r].map((id, index) => ({ id, group: group.get(id) ?? -1, centre: centre(id, index) }));
      keyed.sort((a, b) => a.group - b.group || a.centre - b.centre);
      ranks[r] = keyed.map(({ id }) => id);
    }
  }
  return ranks;
}

/**
 * The flowchart laid out as elements in the public API's form (see shared/src/api-elements.ts): a shape and a label
 * for each node, an arrow or line for each edge, and a frame for each subgraph, with ids starting `prefix`.
 */
export function layoutFlowchart(chart: Flowchart, prefix: string, measure: Measure = estimate): ApiElement[] {
  const vertical = chart.direction === "TD" || chart.direction === "BT";
  const sizes = new Map<string, { width: number; height: number; text: { width: number; height: number } }>();
  for (const node of chart.nodes.values()) {
    const text = measure(node.label, FONT_SIZE);
    let width = Math.max(120, text.width + 40);
    let height = Math.max(60, text.height + 30);
    if (node.shape === "ellipse") [width, height] = [width * 1.3, height * 1.4];
    if (node.shape === "diamond") width = height = Math.max(width, height) * 1.25; // the square, turned on its corner
    sizes.set(node.id, { width, height, text });
  }
  // The space a node takes along the flow (`major`) and across it (`minor`). A diamond's turned square reaches its corners.
  const span = (id: string) => {
    const { width, height } = sizes.get(id)!;
    const reach = chart.nodes.get(id)!.shape === "diamond" ? Math.SQRT2 : 1;
    return vertical ? { major: height * reach, minor: width * reach } : { major: width * reach, minor: height * reach };
  };

  const centres = new Map<string, { x: number; y: number }>();
  const ranks = rankNodes(chart);
  const rankOf = new Map(ranks.flatMap((rank, index) => rank.map((nodeId): [string, number] => [nodeId, index])));
  let along = 0;
  for (const rank of ranks) {
    const majors = rank.map((id) => span(id).major);
    const thickness = Math.max(...majors);
    const total = rank.reduce((sum, id) => sum + span(id).minor, 0) + NODE_GAP * (rank.length - 1);
    let across = -total / 2;
    for (const id of rank) {
      const { minor } = span(id);
      const major = along + thickness / 2;
      const flip = chart.direction === "BT" || chart.direction === "RL" ? -1 : 1;
      centres.set(
        id,
        vertical ? { x: across + minor / 2, y: major * flip } : { x: major * flip, y: across + minor / 2 },
      );
      across += minor + NODE_GAP;
    }
    along += thickness + RANK_GAP;
  }

  const id = (nodeId: string) => `${prefix}${nodeId}`;
  const elements: ApiElement[] = [];
  const nodeElements: ApiElement[] = [];
  const boxes = new Map<string, Rect>();
  for (const node of chart.nodes.values()) {
    const { x, y } = centres.get(node.id)!;
    const { width, height, text } = sizes.get(node.id)!;
    const reach = node.shape === "diamond" ? (width * Math.SQRT2) / 2 : 0;
    boxes.set(
      node.id,
      reach
        ? { x: x - reach, y: y - reach, width: reach * 2, height: reach * 2 }
        : { x: x - width / 2, y: y - height / 2, width, height },
    );
    nodeElements.push({
      id: id(node.id),
      type: node.shape === "ellipse" ? "ellipse" : "rectangle",
      x: x - width / 2,
      y: y - height / 2,
      width,
      height,
      ...(node.shape === "diamond" && { angle: Math.PI / 4 }),
      ...(node.fill && { fill: node.fill }),
    });
    nodeElements.push({
      id: `${id(node.id)}-label`,
      type: "text",
      x: x - text.width / 2,
      y: y - text.height / 2,
      text: node.label,
      fontSize: FONT_SIZE,
    });
  }
  // Frames go underneath: first in the list, so lowest in the stack.
  for (const subgraph of chart.subgraphs) {
    const inside = [...subgraph.nodes].flatMap((nodeId) => boxes.get(nodeId) ?? []);
    if (inside.length === 0) continue;
    const left = Math.min(...inside.map((box) => box.x)) - FRAME_PADDING;
    const top = Math.min(...inside.map((box) => box.y)) - FRAME_PADDING;
    const right = Math.max(...inside.map((box) => box.x + box.width)) + FRAME_PADDING;
    const bottom = Math.max(...inside.map((box) => box.y + box.height)) + FRAME_PADDING;
    elements.push({
      id: id(subgraph.id),
      type: "frame",
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      name: subgraph.title,
    });
  }
  elements.push(...nodeElements);
  chart.edges.forEach((edge, index) => {
    elements.push({
      id: `${prefix}edge-${index + 1}`,
      type: edge.head === "none" ? "line" : "arrow",
      from: id(edge.from),
      to: id(edge.to),
      ...(edge.label && { text: edge.label }),
      ...(edge.head === "both" && { startHead: true }),
      // One that goes back up the flow (a loop) curves, so it isn't drawn over the edge coming the other way.
      ...(rankOf.get(edge.to)! <= rankOf.get(edge.from)! && { route: "curved" }),
    });
  });
  return elements;
}

/**
 * Board elements for Mermaid flowchart `text`, centred on `centre`, and how many of its lines weren't understood.
 * Throws a MermaidError when it can't be imported.
 */
export function mermaidToElements(text: string, centre: { x: number; y: number }, measure?: Measure) {
  const chart = parseFlowchart(text);
  // Ids of their own on every import, so importing twice adds a second copy rather than changing the first.
  const prefix = `mm${[...crypto.getRandomValues(new Uint32Array(1))][0].toString(36)}-`;
  const laidOut = layoutFlowchart(chart, prefix, measure);
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

// The element moved by dx, dy. Lines and arrows keep what they're attached to.
function shift(element: BoardElement, dx: number, dy: number): BoardElement {
  const moved = { ...element } as Record<string, unknown>;
  for (const key of ["x1", "x2"]) if (typeof moved[key] === "number") moved[key] = (moved[key] as number) + dx;
  for (const key of ["y1", "y2"]) if (typeof moved[key] === "number") moved[key] = (moved[key] as number) + dy;
  return moved as BoardElement;
}

// Mermaid text for a label: quoted, with quotes and line breaks written as Mermaid writes them.
const quote = (text: string) => `"${text.replace(/"/g, "#quot;").replace(/\r?\n/g, "<br>")}"`;

const middleOf = (box: Rect) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const area = (box: Rect) => box.width * box.height;

/**
 * The board's diagram as a Mermaid flowchart: rectangles, ellipses and sticky notes are its nodes (labelled by the
 * note's text, or the text inside the shape), lines and arrows attached at both ends its edges, and frames its
 * subgraphs. Returns null when there's no node to export.
 */
export function elementsToMermaid(elements: BoardElement[]): string | null {
  const shapes = elements.filter(
    (element) => element.type === "rectangle" || element.type === "ellipse" || element.type === "sticky",
  );
  if (shapes.length === 0) return null;
  const boxes = new Map(shapes.map((shape) => [shape.id, getBounds(shape)]));
  const nodeId = new Map(shapes.map((shape, index) => [shape.id, `n${index + 1}`]));
  const labels = new Map<string, string[]>();
  const labelOf = new Map<string, string>(); // a text element's id -> the shape it labels
  for (const element of elements) {
    if (element.type !== "text") continue;
    const centre = middleOf(getBounds(element));
    const holder = shapes
      .filter((shape) => shape.type !== "sticky" && rectContains(boxes.get(shape.id)!, centre.x, centre.y))
      .sort((a, b) => area(boxes.get(a.id)!) - area(boxes.get(b.id)!))[0];
    if (!holder) continue;
    labels.set(holder.id, [...(labels.get(holder.id) ?? []), element.text]);
    labelOf.set(element.id, holder.id);
  }

  // Each node goes in the smallest frame its middle is in; frames in the frame they're in.
  const frames = elements.filter(isFrame);
  const frameBoxes = new Map(frames.map((frame) => [frame.id, getBounds(frame)]));
  const innermost = (box: Rect, except?: string) =>
    frames
      .filter((frame) => frame.id !== except)
      .filter((frame) => {
        const { x, y } = middleOf(box);
        const outer = frameBoxes.get(frame.id)!;
        return rectContains(outer, x, y) && area(outer) > area(box);
      })
      .sort((a, b) => area(frameBoxes.get(a.id)!) - area(frameBoxes.get(b.id)!))[0]?.id ?? null;
  const parentOf = new Map<string, string | null>();
  for (const shape of shapes) parentOf.set(shape.id, innermost(boxes.get(shape.id)!));
  for (const frame of frames) parentOf.set(frame.id, innermost(frameBoxes.get(frame.id)!, frame.id));

  const centres = shapes.map((shape) => middleOf(boxes.get(shape.id)!));
  const spreadX = Math.max(...centres.map((c) => c.x)) - Math.min(...centres.map((c) => c.x));
  const spreadY = Math.max(...centres.map((c) => c.y)) - Math.min(...centres.map((c) => c.y));
  const lines = [`flowchart ${spreadX > spreadY ? "LR" : "TD"}`];

  const nodeLine = (shape: BoardElement) => {
    const label = shape.type === "sticky" ? shape.text : (labels.get(shape.id) ?? []).join("\n");
    const text = quote(label || " ");
    const turned =
      shape.type === "rectangle" && Math.abs((Math.abs(shape.angle ?? 0) % (Math.PI / 2)) - Math.PI / 4) < 0.01;
    if (turned) return `${nodeId.get(shape.id)}{${text}}`;
    return shape.type === "ellipse" ? `${nodeId.get(shape.id)}([${text}])` : `${nodeId.get(shape.id)}[${text}]`;
  };
  const write = (parent: string | null, indent: string) => {
    for (const shape of shapes) if (parentOf.get(shape.id) === parent) lines.push(indent + nodeLine(shape));
    frames.forEach((frame, index) => {
      if (parentOf.get(frame.id) !== parent) return;
      lines.push(`${indent}subgraph f${index + 1}[${quote(frame.name || "Frame")}]`);
      write(frame.id, `${indent}  `);
      lines.push(`${indent}end`);
    });
  };
  write(null, "  ");

  const endOf = (id: string | undefined) => (id && labelOf.get(id)) ?? id;
  for (const element of elements) {
    if (element.type !== "arrow" && element.type !== "line") continue;
    const from = nodeId.get(endOf(element.startId) ?? "");
    const to = nodeId.get(endOf(element.endId) ?? "");
    if (!from || !to) continue;
    const link = element.type === "line" ? "---" : element.startHead ? "<-->" : "-->";
    lines.push(`  ${from} ${link}${element.text ? `|${quote(element.text)}|` : ""} ${to}`);
  }
  for (const shape of shapes) {
    const fill = shape.type === "sticky" || shape.type === "rectangle" || shape.type === "ellipse" ? shape.fill : null;
    if (fill) lines.push(`  style ${nodeId.get(shape.id)} fill:${fill}`);
  }
  return `${lines.join("\n")}\n`;
}
