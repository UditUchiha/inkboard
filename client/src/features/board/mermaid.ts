import { ApiElementError, fromApiElement } from "@inkboard/shared/api-elements";
import type { ApiElement } from "@inkboard/shared/api-elements";
import type { Element as BoardElement, FrameElement, ShapeElement, StickyElement } from "@inkboard/shared/types";
import { FILLABLE_TYPES } from "./constants";
import { getBounds, isFrame } from "./elements";
import { normalizeRect, rectContains } from "./geometry";
import type { Rect } from "./geometry";

// Mermaid flowcharts (https://mermaid.js.org/syntax/flowchart.html) and sequence diagrams
// (https://mermaid.js.org/syntax/sequenceDiagram.html), both ways: imported as shapes, labels, arrows, notes and
// frames laid out on the board, and a drawn diagram exported as one. Other kinds (class, state, Gantt…) aren't read:
// flowcharts and sequence diagrams are what boards draw. The text is parsed here rather than by Mermaid's own
// library, which is megabytes and renders HTML; nothing in it is ever rendered as HTML here.

type Direction = "TD" | "LR" | "BT" | "RL";
type NodeShape = "rectangle" | "ellipse" | "diamond";
type Node = { id: string; label: string; shape: NodeShape; fill?: string };
type Edge = { from: string; to: string; label: string; head: "none" | "end" | "both" };
type Subgraph = { id: string; title: string; nodes: Set<string>; parent: Subgraph | null };

/** A flowchart as read from Mermaid: its direction, nodes, edges and subgraphs, and the lines it couldn't read. */
export type Flowchart = {
  direction: Direction;
  nodes: Map<string, Node>;
  edges: Edge[];
  subgraphs: Subgraph[];
  skipped: string[];
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
    .replace(/#(quot|35|59);/g, (_, code: string) => ({ quot: '"', 35: "#", 59: ";" })[code]!)
    .replace(/fa:fa-[\w-]+\s*/g, "")
    .trim();
}

// Splits text into statements: lines, and `;` between statements, but not inside quotes or brackets or entities.
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
      // The `;` of an entity (`#59;`) doesn't end a statement.
      else if (!quoted && depth === 0 && char === ";" && !/#\w{1,8}$/.test(line.slice(Math.max(start, i - 9), i))) {
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

// The text's statements, after any front matter (a title, a theme), which comes first between lines of three dashes.
const readStatements = (text: string) => statements(text.replace(/^\s*---\r?\n[\s\S]*?\r?\n---[^\S\n]*(\r?\n|$)/, ""));

/** Reads a Mermaid flowchart. Throws a MermaidError when it isn't one. */
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
    // A square diamond, big enough for the label between its slanted sides.
    if (node.shape === "diamond") width = height = Math.max(width, height) * 1.25 * Math.SQRT2;
    sizes.set(node.id, { width, height, text });
  }
  // The space a node takes along the flow (`major`) and across it (`minor`).
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

type Participant = { id: string; label: string; actor: boolean };
type SequenceStep =
  | { type: "message"; from: string; to: string; text: string; head: Edge["head"]; dotted: boolean }
  | { type: "note"; side: "left of" | "right of" | "over"; on: string[]; text: string }
  | { type: "block"; keyword: string; text: string } // loop, alt, opt, par, critical or break
  | { type: "branch"; keyword: string; text: string } // the next section of the open block: else, and or option
  | { type: "end" };

/** A sequence diagram as read from Mermaid: its participants, its steps top to bottom, and the lines it couldn't read. */
export type SequenceDiagram = { participants: Map<string, Participant>; steps: SequenceStep[]; skipped: string[] };

const SEQUENCE_HEADER = /^sequenceDiagram\s*$/;
const MAX_STEPS = 1000;
// `A->>B: text`, with any of the arrows, and `+` or `-` (activating) before the second participant. An id can hold
// dashes (`my-service`), so the first arrow after the shortest id that leaves a valid rest is the one meant.
const MESSAGE = /^([^:<>]+?)\s*(<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?\s*([^:<>]+?)\s*(?::(.*))?$/;
const PARTICIPANT = /^(?:create\s+)?(participant|actor)\s+([^:<>@{}]+?)(?:\s+as\s+(.+))?$/i;
const NOTE = /^note\s+(left\s+of|right\s+of|over)\s+([^:]+?)\s*:(.*)$/i;
const BLOCK = /^(loop|alt|opt|par|critical|break)(?:\s+(.*))?$/i;
const BRANCH = /^(else|and|option)(?:\s+(.*))?$/i;
const BRANCH_OF: Record<string, string> = { alt: "else", par: "and", critical: "option" };
const AUTONUMBER = /^autonumber(?:\s+(off|\d+)(?:\s+(\d+))?)?$/i;
// Activations are read but not drawn: the messages say who calls whom, and bars would be more to keep in step.
const SEQUENCE_IGNORED = /^(?:(?:de)?activate\s|acc(?:Title|Descr)\b)/i;
// Coloured backgrounds and boxes around participants aren't drawn, but their `end` must still close them.
const UNDRAWN_BLOCK = /^(rect|box)(\s|$)/i;

/** Reads a Mermaid sequence diagram. Throws a MermaidError when it isn't one. */
export function parseSequence(text: string): SequenceDiagram {
  const lines = readStatements(text);
  if (!SEQUENCE_HEADER.test(lines[0] ?? "")) {
    throw new MermaidError("That isn't a Mermaid sequence diagram: one starts with “sequenceDiagram”.");
  }
  const participants = new Map<string, Participant>();
  const steps: SequenceStep[] = [];
  const skipped: string[] = [];
  const open: string[] = []; // the blocks open, innermost last: their keywords, or "undrawn"
  let numbering: { next: number; step: number } | null = null;

  const meet = (id: string, declared?: { label?: string; actor: boolean }) => {
    let participant = participants.get(id);
    if (!participant) {
      if (participants.size >= MAX_NODES) {
        throw new MermaidError(`That's more than ${MAX_NODES} participants, too many to import.`);
      }
      participant = { id, label: id, actor: false };
      participants.set(id, participant);
    }
    if (declared) {
      participant.actor = declared.actor;
      if (declared.label) participant.label = declared.label;
    }
  };
  const add = (step: SequenceStep) => {
    if (steps.length >= MAX_STEPS) {
      throw new MermaidError(`That's more than ${MAX_STEPS} messages, notes and blocks, too many to import.`);
    }
    steps.push(step);
  };

  for (const line of lines.slice(1)) {
    if (line.length > MAX_STATEMENT_LENGTH) {
      skipped.push(line);
      continue;
    }
    if (SEQUENCE_IGNORED.test(line)) continue;
    const declared = PARTICIPANT.exec(line);
    if (declared) {
      meet(declared[2], {
        label: declared[3] && cleanLabel(declared[3]),
        actor: declared[1].toLowerCase() === "actor",
      });
      continue;
    }
    const note = NOTE.exec(line);
    if (note) {
      const side = note[1].toLowerCase().replace(/\s+/, " ") as "left of" | "right of" | "over";
      const on = [...new Set(note[2].split(",").map((id) => id.trim()))];
      if (on.some((id) => !id) || on.length > (side === "over" ? 2 : 1)) skipped.push(line);
      else {
        on.forEach((id) => meet(id));
        add({ type: "note", side, on, text: cleanLabel(note[3]) });
      }
      continue;
    }
    const autonumber = AUTONUMBER.exec(line);
    if (autonumber) {
      const [, start, step] = autonumber;
      numbering = start?.toLowerCase() === "off" ? null : { next: Number(start ?? 1), step: Number(step ?? 1) };
      continue;
    }
    if (UNDRAWN_BLOCK.test(line)) {
      open.push("undrawn");
      skipped.push(line);
      continue;
    }
    const block = BLOCK.exec(line);
    if (block) {
      open.push(block[1].toLowerCase());
      add({ type: "block", keyword: block[1].toLowerCase(), text: cleanLabel(block[2] ?? "") });
      continue;
    }
    const branch = BRANCH.exec(line);
    if (branch) {
      const keyword = branch[1].toLowerCase();
      if (BRANCH_OF[open.at(-1) ?? ""] === keyword) add({ type: "branch", keyword, text: cleanLabel(branch[2] ?? "") });
      else skipped.push(line); // an `else` outside an `alt`, say
      continue;
    }
    if (/^end$/i.test(line)) {
      const closed = open.pop();
      if (closed === undefined) skipped.push(line);
      else if (closed !== "undrawn") add({ type: "end" });
      continue;
    }
    const message = MESSAGE.exec(line);
    if (message) {
      const [, from, arrow, to, said] = message;
      meet(from);
      meet(to);
      let text = cleanLabel(said ?? "");
      if (numbering) {
        text = `${numbering.next}. ${text}`.trim();
        numbering.next += numbering.step;
      }
      const head = arrow.startsWith("<<") ? "both" : /^-+>$/.test(arrow) ? "none" : "end";
      add({ type: "message", from, to, text, head, dotted: arrow.includes("--") });
      continue;
    }
    skipped.push(line);
  }
  // Blocks left open close at the end, as if their `end` had been written.
  while (open.length > 0) if (open.pop() !== "undrawn") add({ type: "end" });
  if (participants.size === 0) throw new MermaidError("That sequence diagram has no participants to import.");
  return { participants, steps, skipped };
}

const PARTICIPANT_GAP = 50;
const MESSAGE_GAP = 60;
const NOTE_GAP = 30;
const BLOCK_GAP = 40;
const BLOCK_PADDING = 30;
const SELF_HEIGHT = 40; // how far a message to oneself comes down
const NOTE_FONT_SIZE = 16; // a note's text is as big as its shorter side allows (see notes.ts), so that sets its height
// Mermaid draws lifelines and replies dashed. The board has no dashed lines, so they're grey instead.
const QUIET = "#868e96";

/**
 * The sequence diagram laid out as elements in the public API's form, with ids starting `prefix`: a box for each
 * participant (an ellipse for an actor) along the top with a grey lifeline down from it, the messages as arrows
 * between the lifelines in order, notes as sticky notes, and blocks (`loop`, `alt`…) as frames, one for each section.
 */
export function layoutSequence(diagram: SequenceDiagram, prefix: string, measure: Measure = estimate): ApiElement[] {
  const people = [...diagram.participants.values()];
  const column = new Map(people.map((person, index) => [person.id, index]));
  const texts = people.map((person) => measure(person.label, FONT_SIZE));
  const widths = texts.map((text, index) => Math.max(120, text.width + 40) * (people[index].actor ? 1.3 : 1));
  const height = Math.max(
    ...texts.map((text, index) => Math.max(60, text.height + 30) * (people[index].actor ? 1.4 : 1)),
  );
  const noteSize = (text: string) => {
    const size = measure(text, NOTE_FONT_SIZE);
    return { width: Math.max(160, size.width + 60), height: Math.max(NOTE_FONT_SIZE * 7, size.height + 40) };
  };
  // A message to oneself reaches out to the right past its label, which sits halfway along it.
  const selfWidth = (text: string) => measure(text, FONT_SIZE).width + 60;

  // Lifelines far enough apart for the labels and notes between them: each need is a least distance between two.
  const needs: { from: number; to: number; gap: number }[] = [];
  for (const step of diagram.steps) {
    if (step.type === "message") {
      const [a, b] = [column.get(step.from)!, column.get(step.to)!].sort((x, y) => x - y);
      if (a === b) needs.push({ from: a, to: a + 1, gap: selfWidth(step.text) + 40 });
      else needs.push({ from: a, to: b, gap: measure(step.text, FONT_SIZE).width + 60 });
    } else if (step.type === "note" && step.on.length === 1) {
      const at = column.get(step.on[0])!;
      const { width } = noteSize(step.text);
      if (step.side === "left of") needs.push({ from: at - 1, to: at, gap: width + 40 });
      else if (step.side === "right of") needs.push({ from: at, to: at + 1, gap: width + 40 });
      else needs.push({ from: at - 1, to: at, gap: width / 2 + 40 }, { from: at, to: at + 1, gap: width / 2 + 40 });
    }
  }
  const centres = [0];
  for (let index = 1; index < people.length; index += 1) {
    centres.push(centres[index - 1] + widths[index - 1] / 2 + widths[index] / 2 + PARTICIPANT_GAP);
  }
  for (const { from, to, gap } of needs) {
    if (from < 0 || to >= people.length) continue;
    const short = gap - (centres[to] - centres[from]);
    if (short > 0) for (let index = to; index < centres.length; index += 1) centres[index] += short;
  }

  const id = (name: string) => `${prefix}${name}`;
  type Section = { order: number; keyword: string; text: string; top: number };
  type Open = Section & { left: number; right: number; branches: Section[] };
  const open: Open[] = [];
  const frames: { order: number; element: ApiElement }[] = [];
  const drawn: ApiElement[] = [];
  // How far across the innermost open block reaches, so its frame goes round what's in it.
  const reach = (left: number, right: number) => {
    const block = open.at(-1);
    if (block) [block.left, block.right] = [Math.min(block.left, left), Math.max(block.right, right)];
  };
  let y = height + 30;
  let order = 0;
  diagram.steps.forEach((step, index) => {
    if (step.type === "message") {
      const [from, to] = [centres[column.get(step.from)!], centres[column.get(step.to)!]];
      const self = step.from === step.to;
      y += Math.max(MESSAGE_GAP, measure(step.text, FONT_SIZE).height + 30);
      const end = self ? from + selfWidth(step.text) : to;
      drawn.push({
        id: id(`message-${index + 1}`),
        type: step.head === "none" ? "line" : "arrow",
        x1: from,
        y1: y,
        x2: end,
        y2: self ? y + SELF_HEIGHT : y,
        // One to oneself goes out and down: a free end can't loop back to the lifeline it left.
        ...(self && { route: "elbow" }),
        ...(step.text && { text: step.text }),
        ...(step.head === "both" && { startHead: true }),
        ...(step.dotted && { stroke: QUIET }),
      });
      reach(Math.min(from, end), Math.max(from, end));
      if (self) y += SELF_HEIGHT;
    } else if (step.type === "note") {
      const size = noteSize(step.text);
      const xs = step.on.map((on) => centres[column.get(on)!]);
      const [low, high] = [Math.min(...xs), Math.max(...xs)];
      const width = high > low ? Math.max(size.width, high - low + 120) : size.width;
      const left =
        step.side === "left of" ? low - 20 - width : step.side === "right of" ? low + 20 : (low + high) / 2 - width / 2;
      y += NOTE_GAP;
      drawn.push({
        id: id(`note-${index + 1}`),
        type: "sticky",
        x: left,
        y,
        width,
        height: size.height,
        text: step.text,
      });
      reach(left, left + width);
      y += size.height;
    } else if (step.type === "block") {
      y += BLOCK_GAP;
      open.push({
        order: order++,
        keyword: step.keyword,
        text: step.text,
        top: y,
        left: Infinity,
        right: -Infinity,
        branches: [],
      });
    } else if (step.type === "branch") {
      y += BLOCK_GAP;
      open.at(-1)!.branches.push({ order: order++, keyword: step.keyword, text: step.text, top: y });
    } else {
      y += BLOCK_GAP;
      const block = open.pop()!;
      // An empty block goes across them all.
      const [left, right] = Number.isFinite(block.left) ? [block.left, block.right] : [centres[0], centres.at(-1)!];
      for (const section of [block, ...block.branches]) {
        frames.push({
          order: section.order,
          element: {
            id: id(`block-${section.order + 1}`),
            type: "frame",
            x: left - BLOCK_PADDING,
            y: section.top,
            width: right - left + BLOCK_PADDING * 2,
            height: y - section.top,
            name: section.text ? `${section.keyword} ${section.text}` : section.keyword,
          },
        });
      }
      reach(left - BLOCK_PADDING, right + BLOCK_PADDING);
    }
  });

  // Frames go underneath, outer ones first; then the participants and their lifelines, and what's between them.
  const elements = frames.sort((a, b) => a.order - b.order).map((frame) => frame.element);
  people.forEach((person, index) => {
    const [x, width, text] = [centres[index], widths[index], texts[index]];
    elements.push(
      {
        id: id(`participant-${index + 1}`),
        type: person.actor ? "ellipse" : "rectangle",
        x: x - width / 2,
        y: 0,
        width,
        height,
      },
      {
        id: id(`participant-${index + 1}-label`),
        type: "text",
        x: x - text.width / 2,
        y: (height - text.height) / 2,
        text: person.label,
        fontSize: FONT_SIZE,
      },
      {
        id: id(`lifeline-${index + 1}`),
        type: "line",
        x1: x,
        y1: height,
        x2: x,
        y2: y + 40,
        stroke: QUIET,
        strokeWidth: 1,
      },
    );
  });
  elements.push(...drawn);
  return elements;
}

/** What of the text couldn't be read, for the message after an import: how many lines, and the first few of them. */
export function describeSkipped(skipped: string[]): string {
  const shown = skipped.slice(0, 3).map((line) => `“${line.length > 40 ? `${line.slice(0, 39)}…` : line}”`);
  const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
  return `${skipped.length} ${skipped.length === 1 ? "line" : "lines"} of it couldn't be read: ${shown.join(", ")}${more}`;
}

/**
 * Board elements for Mermaid `text` (a flowchart or a sequence diagram), centred on `centre`, and the lines of it
 * that weren't understood. Throws a MermaidError when it can't be imported.
 */
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

// The text inside shapes labels them (a sticky note has its own): each text element labels the smallest shape its
// middle is in. Returns each shape's labels, and the shape each of those text elements labels.
function labelShapes(elements: BoardElement[], shapes: BoardElement[]) {
  const boxes = new Map(shapes.map((shape) => [shape.id, getBounds(shape)]));
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
  return { labels, labelOf };
}

/**
 * The board's diagram as Mermaid: a sequence diagram if it has one (see elementsToSequence), or else a flowchart,
 * whose nodes are shapes and sticky notes (labelled by the note's text, or the text inside the shape),
 * edges lines and arrows attached at both ends, and subgraphs frames. Returns null when there's no node to export.
 */
export function elementsToMermaid(elements: BoardElement[]): string | null {
  const sequence = elementsToSequence(elements);
  if (sequence) return sequence;
  const shapes = elements.filter((element) => element.type === "sticky" || FILLABLE_TYPES.has(element.type));
  if (shapes.length === 0) return null;
  const boxes = new Map(shapes.map((shape) => [shape.id, getBounds(shape)]));
  const nodeId = new Map(shapes.map((shape, index) => [shape.id, `n${index + 1}`]));
  const { labels, labelOf } = labelShapes(elements, shapes);

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
    if (turned || shape.type === "diamond") return `${nodeId.get(shape.id)}{${text}}`;
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
    const fill = "fill" in shape ? shape.fill : null;
    if (fill) lines.push(`  style ${nodeId.get(shape.id)} fill:${fill}`);
  }
  return `${lines.join("\n")}\n`;
}

// Mermaid text for a sequence diagram's message, note or name: on one line, without a `;` that would end it.
const plain = (text: string) => text.replace(/\r?\n/g, "<br>").replace(/;/g, "#59;");
const FRAME_BLOCK = /^(loop|alt|opt|par|critical|break|else|and|option)(?:\s+([\s\S]*))?$/i;
// The box a shape, note or frame is drawn in: getBounds adds the stroke, and a frame's name above it.
const outline = (element: ShapeElement | StickyElement | FrameElement) =>
  normalizeRect(element.x1, element.y1, element.x2, element.y2);

/**
 * The board's sequence diagram, if it has one: a rectangle or ellipse with a line hanging straight down from it is a
 * participant (an ellipse an actor) and its lifeline. Read top to bottom, arrows and lines that start on a lifeline
 * are its messages (grey ones dashed), sticky notes over or beside the lifelines its notes, and frames named after a
 * block (`loop …`, `alt …`, `else …`) its blocks. Returns null when nothing has a lifeline.
 */
function elementsToSequence(elements: BoardElement[]): string | null {
  const shapes = elements.filter(
    (element): element is ShapeElement => element.type === "rectangle" || element.type === "ellipse",
  );
  const lifelines: { id: string; x: number; top: number; bottom: number; shape: ShapeElement }[] = [];
  for (const line of elements) {
    if (line.type !== "line" || line.startId || line.endId || Math.abs(line.x1 - line.x2) > 2) continue;
    const [top, bottom] = [Math.min(line.y1, line.y2), Math.max(line.y1, line.y2)];
    const shape = shapes.find((candidate) => {
      const box = outline(candidate);
      const below = top - (box.y + box.height);
      return below > -2 && below < 30 && line.x1 > box.x && line.x1 < box.x + box.width;
    });
    if (shape && bottom - top > 40 && !lifelines.some((known) => known.shape === shape)) {
      lifelines.push({ id: line.id, x: line.x1, top, bottom, shape });
    }
  }
  if (lifelines.length === 0) return null;
  lifelines.sort((a, b) => a.x - b.x);
  const top = Math.min(...lifelines.map((lifeline) => lifeline.top));
  const bottom = Math.max(...lifelines.map((lifeline) => lifeline.bottom));
  const nearest = (x: number) =>
    lifelines.reduce(
      (best, lifeline, index) => (Math.abs(lifeline.x - x) < Math.abs(lifelines[best].x - x) ? index : best),
      0,
    );

  // A participant's id is its name when that's a plain word, or else p1, p2… with the name as its alias.
  const { labels } = labelShapes(elements, shapes);
  const names = lifelines.map(({ shape }) => (labels.get(shape.id) ?? []).join("\n"));
  const ids = names.map((name, index) =>
    /^[\p{L}\p{N}_]+$/u.test(name) && !/^p\d+$/.test(name) && names.indexOf(name) === index ? name : `p${index + 1}`,
  );
  const lines = ["sequenceDiagram"];
  lifelines.forEach(({ shape }, index) => {
    const kind = shape.type === "ellipse" ? "actor" : "participant";
    const alias = ids[index] === names[index] ? "" : ` as ${plain(names[index] || ids[index])}`;
    lines.push(`  ${kind} ${ids[index]}${alias}`);
  });

  // Everything else as it comes down the page. Where two things are level, a block's end comes before what follows.
  const events: { y: number; rank: number; line: string; change: -1 | 0 | 1; outdent?: boolean }[] = [];
  const lifelineIds = new Set(lifelines.map((lifeline) => lifeline.id));
  for (const element of elements) {
    if (element.type === "line" || element.type === "arrow") {
      if (lifelineIds.has(element.id)) continue;
      const y = Math.min(element.y1, element.y2);
      const from = nearest(element.x1);
      // A message ends on the lifeline it goes to, or, an elbow out to the side, is to the one it starts on.
      const onEnd = Math.abs(lifelines[nearest(element.x2)].x - element.x2) < 20;
      const to = onEnd ? nearest(element.x2) : element.route === "elbow" ? from : -1;
      if (Math.abs(lifelines[from].x - element.x1) >= 20 || to < 0 || y < top || y > bottom) continue;
      const dotted = element.stroke === QUIET;
      const arrow =
        element.type === "line"
          ? dotted
            ? "-->"
            : "->"
          : `${element.startHead ? "<<" : ""}${dotted ? "-->>" : "->>"}`;
      events.push({ y, rank: 2, change: 0, line: `${ids[from]}${arrow}${ids[to]}: ${plain(element.text ?? "")}` });
    } else if (element.type === "sticky") {
      const box = outline(element);
      if (box.y < top || box.y > bottom) continue;
      const over = lifelines.flatMap((lifeline, index) =>
        lifeline.x >= box.x && lifeline.x <= box.x + box.width ? [index] : [],
      );
      const beside = nearest(box.x + box.width / 2);
      const where =
        over.length > 0
          ? `over ${[...new Set([over[0], over.at(-1)!])].map((index) => ids[index]).join(",")}`
          : `${box.x + box.width / 2 < lifelines[beside].x ? "left of" : "right of"} ${ids[beside]}`;
      events.push({ y: box.y, rank: 2, change: 0, line: `Note ${where}: ${plain(element.text)}` });
    } else if (isFrame(element)) {
      const block = FRAME_BLOCK.exec(element.name.trim());
      if (!block) continue;
      const box = outline(element);
      const keyword = block[1].toLowerCase();
      const line = `${keyword}${block[2] ? ` ${plain(block[2])}` : ""}`;
      // A later section (`else`, `and`, `option`) is written level with its block, whose `end` closes it too.
      if (keyword === "else" || keyword === "and" || keyword === "option") {
        events.push({ y: box.y, rank: 1, change: 0, outdent: true, line });
      } else {
        events.push(
          { y: box.y, rank: 1, change: 1, line },
          { y: box.y + box.height, rank: 0, change: -1, line: "end" },
        );
      }
    }
  }
  events.sort((a, b) => a.y - b.y || a.rank - b.rank);
  let depth = 1;
  for (const { line, change, outdent } of events) {
    if (change < 0) depth = Math.max(1, depth - 1);
    lines.push(`${"  ".repeat(Math.max(1, depth - (outdent ? 1 : 0)))}${line}`);
    if (change > 0) depth += 1;
  }
  return `${lines.join("\n")}\n`;
}
