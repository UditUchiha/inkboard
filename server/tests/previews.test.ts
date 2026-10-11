import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element, PenElement, Point, ShapeElement, TextElement } from "@inkboard/shared/types";
import { MAX_PREVIEW_ELEMENTS, previewElements, simplifyPoints } from "../src/services/previews.ts";

const stroke = (id: string, points: unknown, extra: Record<string, unknown> = {}): PenElement =>
  ({
    id,
    type: "pen",
    points,
    pressure: false,
    stroke: "#000",
    penSize: 4,
    ...extra,
  }) as unknown as PenElement;
const box = (id: string, size: number): ShapeElement =>
  ({ id, type: "rectangle", x1: 0, y1: 0, x2: size, y2: size, stroke: "#000" }) as unknown as ShapeElement;

describe("simplifying a line", () => {
  it("drops points that sit on a straight line, keeping both ends", () => {
    const points = Array.from({ length: 101 }, (_, index) => [index, index * 2, 0.5] as Point);
    assert.deepEqual(simplifyPoints(points, 0.5), [points[0], points[100]]);
  });

  it("keeps the corners that give a line its shape", () => {
    const points: [number, number][] = [
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 5],
      [10, 10],
    ];
    assert.deepEqual(simplifyPoints(points, 0.5), [
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it("copes with very long strokes", () => {
    const points: [number, number][] = Array.from({ length: 200_000 }, (_, index) => [
      index,
      Math.sin(index / 50) * 100,
    ]);
    const simplified = simplifyPoints(points, 1);
    assert.ok(simplified.length > 2 && simplified.length < 20_000, `${simplified.length} points`);
  });
});

describe("board previews", () => {
  it("thins out pen strokes to what a thumbnail can show, and leaves other elements alone", () => {
    const wiggle = Array.from({ length: 2000 }, (_, index) => [index, Math.sin(index / 100) * 300, 0.5] as Point);
    const elements = [
      box("frame", 2000),
      stroke("pen", wiggle),
      { id: "t", type: "text", x1: 5, y1: 5, text: "Hi" } as TextElement,
    ];
    const preview = previewElements(elements);

    assert.deepEqual(
      preview.map((element) => element.id),
      ["frame", "pen", "t"],
    );
    assert.deepEqual(preview[0], elements[0]);
    assert.deepEqual(preview[2], elements[2]);
    assert.ok(
      (preview[1] as PenElement).points.length < 200,
      `${(preview[1] as PenElement).points.length} points kept of 2000`,
    );
    assert.ok(JSON.stringify(preview).length < JSON.stringify(elements).length / 5);
  });

  it("cuts long text to what a thumbnail could show, and drops the sync stamps", () => {
    const stamped = { version: 7, versionNonce: 99, stamps: { text: [3, 5] as [number, number] } };
    const preview = previewElements([
      { id: "t", type: "text", x1: 0, y1: 0, text: "x".repeat(20_000), ...stamped } as unknown as Element,
      {
        ...stroke("pen", [
          [0, 0, 0.5],
          [9, 9, 0.5],
        ]),
        ...stamped,
      } as unknown as Element,
      { ...box("b", 50), ...stamped } as unknown as Element,
    ]);
    assert.equal((preview[0] as TextElement).text.length, 300);
    for (const element of preview) {
      assert.equal(element.version, undefined);
      assert.equal(element.versionNonce, undefined);
      assert.equal(element.stamps, undefined);
    }
    assert.deepEqual(
      preview.map((element) => element.id),
      ["t", "pen", "b"],
    );
  });

  it("draws strokes without real pen pressure at an even width", () => {
    const [preview] = previewElements([
      stroke("pen", [
        [0, 0, 0.9],
        [50, 50, 0.1],
        [100, 0, 0.3],
      ]),
    ]);
    assert.equal((preview as PenElement).pressure, true);
    assert.ok((preview as PenElement).points.every((point: Point) => point[2] === 0.5));
  });

  it("keeps real pen pressure", () => {
    const [preview] = previewElements([
      stroke(
        "pen",
        [
          [0, 0, 0.9],
          [50, 50, 0.1],
          [100, 0, 0.3],
        ],
        { pressure: true },
      ),
    ]);
    assert.deepEqual(
      (preview as PenElement).points.map((point: Point) => point[2]),
      [0.9, 0.1, 0.3],
    );
  });

  it("keeps only the biggest elements of a very busy board, in their order", () => {
    const tiny = Array.from({ length: MAX_PREVIEW_ELEMENTS }, (_, index) => box(`tiny-${index}`, 1));
    const elements = [...tiny.slice(0, 10), box("big", 500), ...tiny.slice(10)];
    const preview = previewElements(elements);
    assert.equal(preview.length, MAX_PREVIEW_ELEMENTS);
    assert.equal(preview[10].id, "big");
  });

  it("survives odd or empty input", () => {
    assert.deepEqual(previewElements([]), []);
    // @ts-expect-error deliberately passing undefined
    assert.deepEqual(previewElements(undefined), []);
    const odd = [
      stroke("pen", [[0, 0], "nonsense", [Number.NaN, 1], [3, 4]]),
      { id: "x", type: "rectangle" },
    ] as unknown as Element[];
    assert.deepEqual((previewElements(odd)[0] as PenElement).points, [
      [0, 0, 0.5],
      [3, 4, 0.5],
    ]);
  });
});
