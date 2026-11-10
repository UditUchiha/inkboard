import type { ApiElement } from "@inkboard/shared/api-elements";
import type { Rect } from "../elements/geometry";
import {
  FONT_SIZE,
  MAX_NODES,
  MAX_STATEMENT_LENGTH,
  MermaidError,
  cleanLabel,
  estimate,
  readStatements,
} from "./common";
import type { Measure } from "./common";

export type Direction = "TD" | "LR" | "BT" | "RL";
export type NodeShape = "rectangle" | "ellipse" | "diamond";
export type Node = { id: string; label: string; shape: NodeShape; fill?: string };
export type Edge = { from: string; to: string; label: string; head: "none" | "end" | "both" };
export type Subgraph = { id: string; title: string; nodes: Set<string>; parent: Subgraph | null };

export type Flowchart = {
  direction: Direction;
  nodes: Map<string, Node>;
  edges: Edge[];
  subgraphs: Subgraph[];
  skipped: string[];
};

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
// Text in the middle or after (`-->|text|`); dotted and thick links draw the same; `o`/`x` ends draw as arrowheads.
const LINK =
  /^(<)?(?:(--|==|-\.)\s*([^|>]+?)\s*)?(-{2,}>|-{3,}|={2,}>|={3,}|-?\.+-+>|-?\.+-|--[ox]|==[ox])(?:\s*\|([^|]*)\|)?/;
const IGNORED = /^(classDef|class|linkStyle|click|accTitle|accDescr|direction)\b/;

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

export function parseFlowchart(text: string): Flowchart {
  const lines = readStatements(text);
  const header = /^(flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*$/i.exec(lines[0] ?? "");
  if (!header) {
    throw new MermaidError(
      lines.length === 0
        ? "Paste a Mermaid flowchart or sequence diagram to import."
        : "Only Mermaid flowcharts and sequence diagrams can be imported: ones that start with “flowchart”, “graph” or “sequenceDiagram”.",
    );
  }
  const direction = (header[2] ?? "TD").toUpperCase().replace("TB", "TD") as Direction;
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const subgraphs: Subgraph[] = [];
  let open: Subgraph | null = null;
  const skipped: string[] = [];

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
      skipped.push(line);
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
      skipped.push(line);
      continue;
    }
    found.forEach(note);
    edges.push(...linked);
  }
  if (nodes.size === 0) throw new MermaidError("That flowchart has no nodes to import.");
  return { direction, nodes, edges, subgraphs, skipped };
}

const RANK_GAP = 90;
const NODE_GAP = 60;
const FRAME_PADDING = 40;

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

export function layoutFlowchart(chart: Flowchart, prefix: string, measure: Measure = estimate): ApiElement[] {
  const vertical = chart.direction === "TD" || chart.direction === "BT";
  const sizes = new Map<string, { width: number; height: number; text: { width: number; height: number } }>();
  for (const node of chart.nodes.values()) {
    const text = measure(node.label, FONT_SIZE);
    let width = Math.max(120, text.width + 40);
    let height = Math.max(60, text.height + 30);
    if (node.shape === "ellipse") [width, height] = [width * 1.3, height * 1.4];
    if (node.shape === "diamond") width = height = Math.max(width, height) * 1.25 * Math.SQRT2;
    sizes.set(node.id, { width, height, text });
  }
  const span = (id: string) => {
    const { width, height } = sizes.get(id)!;
    return vertical ? { major: height, minor: width } : { major: width, minor: height };
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
    boxes.set(node.id, { x: x - width / 2, y: y - height / 2, width, height });
    nodeElements.push({
      id: id(node.id),
      type: node.shape,
      x: x - width / 2,
      y: y - height / 2,
      width,
      height,
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
