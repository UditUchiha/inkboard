import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element, ShapeElement, TextElement } from "@inkboard/shared/types";
import {
  elementsToMermaid,
  layoutFlowchart,
  MermaidError,
  mermaidToElements,
  parseFlowchart,
} from "../src/features/board/mermaid.ts";

// Text is measured with a canvas, which Node doesn't have: a stand-in makes every character 10 wide.
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({
    getContext: () => ({
      font: "",
      measureText: (text: string) => ({ width: text.length * 10 }),
    }),
  }),
};

const SIGNUP = `---
title: Sign up
---
flowchart LR
  %% the happy path
  start([Sign up]) --> form[Fill in the form]
  form --> check{Email ok?}
  check -->|yes| welcome["Welcome #quot;screen#quot;"]
  check -- no --> form
  subgraph after [After signing up]
    welcome --> tour((Tour)) & docs[[Docs]]
  end
  style welcome fill:#b2f2bb
  classDef fancy fill:#f9f
  A-->B; B-.->C
  C ==> D
  D <--> A
  D --- E
  this is not mermaid
`;

describe("reading a Mermaid flowchart", () => {
  const chart = parseFlowchart(SIGNUP);

  it("reads nodes with their shapes and labels, after any front matter", () => {
    assert.equal(chart.direction, "LR");
    const node = (id: string) => chart.nodes.get(id)!;
    assert.deepEqual([node("start").shape, node("start").label], ["ellipse", "Sign up"]);
    assert.deepEqual([node("check").shape, node("check").label], ["diamond", "Email ok?"]);
    assert.deepEqual([node("tour").shape, node("docs").shape], ["ellipse", "rectangle"]);
    assert.equal(node("welcome").fill, "#b2f2bb");
    assert.equal(node("A").label, "A", "a node without a label is labelled with its id");
  });

  it("reads links of every kind, with labels either way, chains and &", () => {
    const edge = (from: string, to: string) => chart.edges.find((e) => e.from === from && e.to === to)!;
    assert.deepEqual([edge("check", "welcome").label, edge("check", "form").label], ["yes", "no"]);
    assert.ok(edge("welcome", "tour") && edge("welcome", "docs"), "welcome --> tour & docs");
    assert.ok(edge("A", "B") && edge("B", "C") && edge("C", "D"), "no spaces, ;, dotted and thick links");
    assert.deepEqual([edge("D", "A").head, edge("D", "E").head, edge("A", "B").head], ["both", "none", "end"]);
  });

  it("keeps subgraphs, and counts what it couldn't read", () => {
    assert.deepEqual([...chart.subgraphs[0].nodes].sort(), ["docs", "tour", "welcome"]);
    assert.equal(chart.subgraphs[0].title, "After signing up");
    assert.equal(chart.skipped, 1);
  });

  it("passes over a line too long to read quickly, whatever is in it", () => {
    const started = performance.now();
    const chart = parseFlowchart(`flowchart TD\n  a --> b\n  a ${"-".repeat(50_000)} b`);
    assert.equal(chart.skipped, 1);
    assert.ok(performance.now() - started < 500);
  });

  it("says plainly what it can't import", () => {
    assert.throws(() => parseFlowchart("sequenceDiagram\n  A->>B: hi"), MermaidError);
    assert.throws(() => parseFlowchart("   "), /Paste a Mermaid flowchart/);
  });
});

describe("laying a flowchart out", () => {
  it("puts each step after the one before it, in the flowchart's direction, without overlaps", () => {
    const laidOut = layoutFlowchart(parseFlowchart("flowchart TD\n a --> b --> c\n a --> c\n c --> a"), "p-");
    const box = (id: string) => laidOut.find((element) => element.id === `p-${id}`)! as Record<string, number>;
    assert.ok(box("a").y < box("b").y && box("b").y < box("c").y, "down the page, a loop back ignored");
    const sideways = layoutFlowchart(parseFlowchart("flowchart LR\n a --> b & c"), "q-");
    const at = (id: string) => sideways.find((element) => element.id === `q-${id}`)! as Record<string, number>;
    assert.ok(at("a").x < at("b").x);
    assert.ok(at("b").y + at("b").height <= at("c").y || at("c").y + at("c").height <= at("b").y, "b and c apart");
  });
});

describe("importing and exporting", () => {
  it("makes shapes, labels, arrows and frames, centred where asked, and exports them back to the same flowchart", () => {
    const { elements, skipped } = mermaidToElements(SIGNUP, { x: 1000, y: 500 });
    assert.equal(skipped, 1);
    const count = (type: string) => elements.filter((element) => element.type === type).length;
    assert.equal(count("frame"), 1);
    assert.equal(count("text"), 11, "a label for each node");
    assert.ok(count("arrow") >= 9 && count("line") === 1);
    const diamond = elements.find((element) => (element as ShapeElement).angle) as ShapeElement;
    assert.equal(diamond.angle, Math.PI / 4, "the decision is a square on its corner");
    const xs = elements.flatMap((element) => ("x1" in element ? [element.x1] : []));
    assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 1000) < 400, "around the centre given");

    const exported = elementsToMermaid(elements)!;
    assert.match(exported, /^flowchart LR\n/);
    assert.match(exported, /\{"Email ok\?"\}/);
    assert.match(exported, /subgraph f1\["After signing up"\]/);
    assert.match(exported, /-->\|"yes"\|/);
    assert.match(exported, /style n\d+ fill:#b2f2bb/, "fills go with it");
    const loop = elements.find((element) => element.type === "arrow" && (element as ShapeElement).text === "no");
    assert.equal((loop as ShapeElement).route, "curved", "the loop back to the form curves");
    const again = parseFlowchart(exported);
    assert.equal(again.nodes.size, parseFlowchart(SIGNUP).nodes.size);
    assert.equal(again.edges.length, parseFlowchart(SIGNUP).edges.length);
    const labels = [...again.nodes.values()].map((node) => node.label).sort();
    assert.ok(labels.includes('Welcome "screen"'), "quotes survive the round trip");
  });

  it("exports nothing from a board without shapes or notes", () => {
    const text = { id: "t", type: "text", x1: 0, y1: 0, text: "Just words", fontSize: 20 } as TextElement;
    assert.equal(elementsToMermaid([text as Element]), null);
  });
});
