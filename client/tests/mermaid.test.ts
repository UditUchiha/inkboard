import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element, ShapeElement, TextElement } from "@inkboard/shared/types";
import {
  describeSkipped,
  elementsToMermaid,
  layoutFlowchart,
  layoutSequence,
  MermaidError,
  mermaidToElements,
  parseFlowchart,
  parseSequence,
} from "../src/features/board/mermaid.ts";
import type { ApiElement } from "@inkboard/shared/api-elements";

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

  it("keeps subgraphs, and lists what it couldn't read", () => {
    assert.deepEqual([...chart.subgraphs[0].nodes].sort(), ["docs", "tour", "welcome"]);
    assert.equal(chart.subgraphs[0].title, "After signing up");
    assert.deepEqual(chart.skipped, ["this is not mermaid"]);
  });

  it("passes over a line too long to read quickly, whatever is in it", () => {
    const started = performance.now();
    const chart = parseFlowchart(`flowchart TD\n  a --> b\n  a ${"-".repeat(50_000)} b`);
    assert.equal(chart.skipped.length, 1);
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
    assert.equal(skipped.length, 1);
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

  it("says which lines it couldn't read, the first few of them", () => {
    assert.equal(describeSkipped(["box Aqua"]), "1 line of it couldn't be read: “box Aqua”");
    const many = describeSkipped(["a", "b", "c", "d", "x".repeat(60)]);
    assert.equal(many, "5 lines of it couldn't be read: “a”, “b”, “c” and 2 more");
  });
});

const CHECKOUT = `sequenceDiagram
  %% buying something
  autonumber
  actor C as Customer
  participant Shop
  participant Pay as Payments<br>service
  C->>Shop: Add to basket
  activate Shop
  Shop-->>C: Basket total
  deactivate Shop
  Note right of C: Thinks it over
  loop Every 5 seconds
    Shop->>+Pay: Status?
    Pay--x-Shop: Pending
  end
  alt Card ok
    Pay->>Shop: Paid#59; thanks
  else Declined
    Pay-)Shop: Declined
    opt Retry
      Shop->Shop: Try again
    end
  end
  Note over C,Shop: Done
  par Email
    Shop-->C: Receipt
  and SMS
    Shop<<->>C: Text
  end
  critical Ship it
    Shop->>Pay: Capture
  option Fails
    Shop->>C: Sorry
  end
  break Out of stock
    Shop-xC: None left
  end
  rect rgb(200, 220, 255)
    C->>Shop: Thanks
  end
  box Aqua Group
  end
  title Checkout
  else Nowhere
  end
  this is not mermaid
`;

describe("reading a Mermaid sequence diagram", () => {
  const diagram = parseSequence(CHECKOUT);
  const messages = diagram.steps.flatMap((step) => (step.type === "message" ? [step] : []));
  const message = (text: string) => messages.find((step) => step.text.endsWith(text))!;

  it("reads participants and actors in order, with their aliases", () => {
    const people = [...diagram.participants.values()];
    assert.deepEqual(
      people.map(({ id, label, actor }) => [id, label, actor]),
      [
        ["C", "Customer", true],
        ["Shop", "Shop", false],
        ["Pay", "Payments\nservice", false],
      ],
    );
    const implicit = parseSequence("sequenceDiagram\n  my-service->>Max-xavier: hi");
    assert.deepEqual(
      [...implicit.participants.keys()],
      ["my-service", "Max-xavier"],
      "ids with dashes, met in messages",
    );
  });

  it("reads messages with every kind of arrow, numbered after autonumber", () => {
    assert.equal(messages[0].text, "1. Add to basket");
    assert.equal(messages.length, 13);
    const kind = (text: string) => [message(text).head, message(text).dotted];
    assert.deepEqual(kind("Basket total"), ["end", true]);
    assert.deepEqual(kind("Pending"), ["end", true], "--x");
    assert.deepEqual(kind("Declined"), ["end", false], "-)");
    assert.deepEqual(kind("None left"), ["end", false], "-x");
    assert.deepEqual(kind("Try again"), ["none", false]);
    assert.deepEqual(kind("Receipt"), ["none", true]);
    assert.deepEqual(kind("Text"), ["both", false]);
    assert.deepEqual([message("Status?").from, message("Status?").to], ["Shop", "Pay"], "activation + read past");
    assert.ok(message("Paid; thanks"), "#59; is a semicolon");
  });

  it("reads notes and blocks, and lists what it couldn't read", () => {
    const notes = diagram.steps.flatMap((step) => (step.type === "note" ? [[step.side, step.on, step.text]] : []));
    assert.deepEqual(notes, [
      ["right of", ["C"], "Thinks it over"],
      ["over", ["C", "Shop"], "Done"],
    ]);
    const blocks = diagram.steps.flatMap((step) =>
      step.type === "block" || step.type === "branch"
        ? [`${step.keyword} ${step.text}`]
        : step.type === "end"
          ? ["end"]
          : [],
    );
    assert.deepEqual(blocks, [
      ...["loop Every 5 seconds", "end", "alt Card ok", "else Declined", "opt Retry", "end", "end"],
      ...["par Email", "and SMS", "end", "critical Ship it", "option Fails", "end", "break Out of stock", "end"],
    ]);
    assert.deepEqual(diagram.skipped, [
      "rect rgb(200, 220, 255)",
      "box Aqua Group",
      "title Checkout",
      "else Nowhere",
      "end",
      "this is not mermaid",
    ]);
  });

  it("closes blocks left open, and passes over what's malformed", () => {
    const loose = parseSequence(
      "sequenceDiagram\n  loop Forever\n  A->>B: hi\n  Note over A,B,C: too many\n  A->>: who?",
    );
    assert.deepEqual(
      loose.steps.map((step) => step.type),
      ["block", "message", "end"],
    );
    assert.deepEqual(loose.skipped, ["Note over A,B,C: too many", "A->>: who?"]);
  });

  it("reads long lines quickly, whatever is in them", () => {
    const started = performance.now();
    const lines = [`A->>${" ".repeat(990)}x`, `${"a->".repeat(330)}`, `participant ${"a ".repeat(490)}`];
    parseSequence(`sequenceDiagram\n${lines.join("\n")}\n${"-".repeat(50_000)}`);
    assert.ok(performance.now() - started < 500);
  });

  it("says plainly what it can't import", () => {
    assert.throws(() => parseSequence("flowchart TD\n  a --> b"), MermaidError);
    assert.throws(() => parseSequence("sequenceDiagram\n  title Nothing here"), /no participants/);
    assert.throws(() => mermaidToElements("classDiagram\n  Animal <|-- Duck", { x: 0, y: 0 }), /sequence diagrams/);
  });
});

describe("laying a sequence diagram out", () => {
  const laidOut = layoutSequence(parseSequence(CHECKOUT), "s-");
  const find = (id: string) => laidOut.find((element) => element.id === `s-${id}`)! as Record<string, number>;
  const messages = laidOut.filter((element) => element.id.startsWith("s-message-")) as Record<string, number>[];

  it("puts the participants in a row along the top, each with a grey lifeline down from it", () => {
    const [a, b, c] = [1, 2, 3].map((n) => find(`participant-${n}`));
    assert.equal(laidOut.find((element) => element.id === "s-participant-1")!.type, "ellipse", "the actor");
    assert.ok(a.y === b.y && b.y === c.y && a.x + a.width < b.x && b.x + b.width < c.x);
    for (const n of [1, 2, 3]) {
      const [box, lifeline] = [find(`participant-${n}`), find(`lifeline-${n}`)];
      assert.equal(lifeline.x1, box.x + box.width / 2);
      assert.equal(lifeline.y1, box.y + box.height);
      assert.ok(lifeline.y2 > Math.max(...messages.map((m) => m.y1)), "past the last message");
    }
  });

  it("draws the messages in order down the page, from lifeline to lifeline", () => {
    const ys = messages.map((m) => m.y1);
    assert.deepEqual(
      [...ys].sort((p, q) => p - q),
      ys,
    );
    assert.equal(new Set(ys).size, ys.length);
    const first = messages[0];
    assert.deepEqual([first.x1, first.x2], [find("lifeline-1").x1, find("lifeline-2").x1]);
    const self = laidOut.find((element) => element.text === "7. Try again")! as Record<string, unknown>;
    assert.equal(self.route, "elbow", "a message to oneself goes out and comes down");
    const reply = laidOut.find((element) => element.text === "2. Basket total")!;
    assert.equal(reply.stroke, "#868e96", "a dashed reply is grey");
  });

  it("puts notes beside or over their lifelines, and blocks round their messages", () => {
    const note = laidOut.find((element) => element.type === "sticky" && element.text === "Thinks it over")!;
    const [left, right] = [note.x as number, (note.x as number) + (note.width as number)];
    assert.ok(left > find("lifeline-1").x1 && right < find("lifeline-2").x1, "right of the customer");
    const loop = laidOut.find((element) => element.name === "loop Every 5 seconds")! as Record<string, number>;
    const inside = messages.filter((m) => m.y1 > loop.y && m.y1 < loop.y + loop.height);
    assert.equal(inside.length, 2);
    for (const m of inside) assert.ok(Math.min(m.x1, m.x2) > loop.x && Math.max(m.x1, m.x2) < loop.x + loop.width);
    const alt = laidOut.find((element) => element.name === "alt Card ok")! as Record<string, number>;
    const declined = laidOut.find((element) => element.name === "else Declined")! as Record<string, number>;
    const retry = laidOut.find((element) => element.name === "opt Retry")! as Record<string, number>;
    assert.ok(
      alt.y < declined.y && declined.y + declined.height === alt.y + alt.height,
      "else is the alt's lower part",
    );
    assert.ok(retry.x > alt.x && retry.y + retry.height < alt.y + alt.height, "opt nested inside");
    assert.ok(
      laidOut.indexOf(laidOut.find((e) => e.name === "alt Card ok")!) <
        laidOut.indexOf(laidOut.find((e) => e.name === "opt Retry")!),
      "outer frame underneath",
    );
  });
});

describe("importing and exporting a sequence diagram", () => {
  // The layout without ids, which differ between imports.
  const drawing = (elements: ApiElement[]) => elements.map(({ id: _id, ...rest }) => rest);

  it("exports what it imports, and that imports as the same diagram", () => {
    const { elements, skipped } = mermaidToElements(CHECKOUT, { x: 300, y: -200 });
    assert.equal(skipped.length, 6);
    const exported = elementsToMermaid(elements)!;
    // Participants are named by their labels where they're one word.
    assert.match(
      exported,
      /^sequenceDiagram\n {2}actor Customer\n {2}participant Shop\n {2}participant p3 as Payments<br>service\n/,
    );
    assert.match(exported, /\n {2}Customer->>Shop: 1\. Add to basket\n {2}Shop-->>Customer: 2\. Basket total\n/);
    assert.match(exported, /\n {2}Note right of Customer: Thinks it over\n {2}loop Every 5 seconds\n {4}Shop->>p3/);
    assert.match(
      exported,
      /\n {2}else Declined\n {4}p3->>Shop: 6\. Declined\n {4}opt Retry\n {6}Shop->Shop: 7\. Try again\n {4}end\n {2}end\n/,
    );
    assert.match(exported, /Paid#59; thanks/, "a semicolon doesn't end the line");
    assert.match(exported, /\n {2}Note over Customer,Shop: Done\n/);
    assert.match(exported, /\n {4}Shop<<->>Customer: 9\. Text\n {2}end\n/);
    assert.deepEqual(
      drawing(layoutSequence(parseSequence(exported), "")),
      drawing(layoutSequence(parseSequence(CHECKOUT), "")),
    );
    assert.deepEqual(parseSequence(exported).skipped, []);
  });

  it("keeps exporting a drawing without lifelines as a flowchart", () => {
    const { elements } = mermaidToElements("flowchart TD\n  a --> b\n  b --- c", { x: 0, y: 0 });
    assert.match(elementsToMermaid(elements)!, /^flowchart TD\n/);
  });
});
