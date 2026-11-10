import type { ApiElement } from "@inkboard/shared/api-elements";
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
import type { Edge } from "./flowchart";

type Participant = { id: string; label: string; actor: boolean };
type SequenceStep =
  | { type: "message"; from: string; to: string; text: string; head: Edge["head"]; dotted: boolean }
  | { type: "note"; side: "left of" | "right of" | "over"; on: string[]; text: string }
  | { type: "block"; keyword: string; text: string } // loop, alt, opt, par, critical or break
  | { type: "branch"; keyword: string; text: string } // the next section of the open block: else, and or option
  | { type: "end" };

export type SequenceDiagram = { participants: Map<string, Participant>; steps: SequenceStep[]; skipped: string[] };

export const SEQUENCE_HEADER = /^sequenceDiagram\s*$/;
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
export const QUIET = "#868e96";

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
