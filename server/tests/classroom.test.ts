import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element, FrameElement, Stamp } from "@inkboard/shared/types";
import {
  classroomFor,
  nextClassroom,
  outsideZone,
  readClassroom,
  savedClassroom,
  zoneOf,
} from "../src/realtime/classroom.ts";
import type { ClassroomActor, ClassroomState } from "../src/realtime/classroom.ts";

const frames = new Map<string, FrameElement>([
  ["f1", { id: "f1", type: "frame", x1: 0, y1: 0, x2: 400, y2: 300, name: "Frame 1" }],
  ["f2", { id: "f2", type: "frame", x1: 500, y1: 0, x2: 900, y2: 300, name: "Frame 2" }],
]);
const isFrame = (id: string) => frames.has(id);
const teacher: ClassroomActor = { id: "t", name: "Teacher", member: true, student: false, isFrame };
const asha: ClassroomActor = { id: "a", name: "Asha", member: false, student: true, isFrame };
const ben: ClassroomActor = { id: "b", name: "Ben", member: false, student: true, isFrame };

const started = nextClassroom(null, { action: "start" }, teacher)!;
const claimed = (state: ClassroomState, actor: ClassroomActor, frameId: string) =>
  nextClassroom(state, { action: "claim", frameId }, actor);

describe("nextClassroom", () => {
  it("lets only a member start and stop it, and keeps the claims when it stops", () => {
    assert.equal(nextClassroom(null, { action: "start" }, asha), undefined);
    assert.equal(nextClassroom(started, { action: "start" }, teacher), undefined, "already on");
    const withAsha = claimed(started, asha, "f1")!;
    assert.equal(nextClassroom(withAsha, { action: "stop" }, asha), undefined);
    const stopped = nextClassroom(withAsha, { action: "stop" }, teacher)!;
    assert.equal(stopped.on, false);
    assert.equal(stopped.claims.get("f1")?.name, "Asha");
  });

  it("lets a student claim one empty frame while it's on, and no one else's", () => {
    const withAsha = claimed(started, asha, "f1")!;
    assert.equal(claimed(withAsha, ben, "f1"), undefined, "taken");
    assert.equal(claimed(withAsha, asha, "f2"), undefined, "Asha has one");
    assert.equal(claimed(withAsha, teacher, "f2"), undefined, "the teacher doesn't claim");
    assert.equal(claimed(withAsha, ben, "nope"), undefined, "not a frame");
    assert.equal(claimed(nextClassroom(withAsha, { action: "stop" }, teacher)!, ben, "f2"), undefined, "off");
    assert.equal(claimed(withAsha, ben, "f2")?.claims.get("f2")?.by, "b");
  });

  it("lets a student claim again when their frame was deleted", () => {
    const state: ClassroomState = { on: true, claims: new Map([["gone", { by: "a", name: "Asha" }]]) };
    const again = claimed(state, asha, "f2")!;
    assert.deepEqual([...again.claims.keys()], ["f2"]);
  });

  it("lets only a member free a frame", () => {
    const withAsha = claimed(started, asha, "f1")!;
    assert.equal(nextClassroom(withAsha, { action: "release", frameId: "f1" }, asha), undefined);
    assert.equal(nextClassroom(withAsha, { action: "release", frameId: "f1" }, teacher)?.claims.size, 0);
  });

  it("ignores what isn't an action", () => {
    assert.equal(nextClassroom(started, null, teacher), undefined);
    assert.equal(nextClassroom(started, { action: "dance" } as never, teacher), undefined);
  });
});

describe("classroomFor, zoneOf and saving", () => {
  const state = claimed(claimed(started, asha, "f1")!, ben, "f2")!;

  it("tells each person which claim is theirs, and leaves out deleted frames", () => {
    const view = classroomFor(state, "a", true, (id) => id === "f1");
    assert.deepEqual(view, { on: true, restricted: true, claims: [{ frameId: "f1", name: "Asha", mine: true }] });
  });

  it("gives a student their frame, null without one, and nothing for a member", () => {
    const frameOf = (id: string) => frames.get(id);
    assert.equal(zoneOf(state, "a", true, frameOf)?.id, "f1");
    assert.equal(zoneOf(state, "c", true, frameOf), null);
    assert.equal(zoneOf(state, "t", false, frameOf), undefined);
    assert.equal(zoneOf({ ...state, on: false }, "a", true, frameOf), undefined);
  });

  it("is read back as it was saved, and refuses what this server didn't write", () => {
    const back = readClassroom(JSON.parse(JSON.stringify(savedClassroom(state))))!;
    assert.deepEqual([...back.claims], [...state.claims]);
    assert.equal(readClassroom({ on: "yes" }), null);
    assert.equal(readClassroom(null), null);
  });
});

describe("outsideZone", () => {
  const zone = frames.get("f1")!;
  const box = (id: string, x: number) =>
    ({ id, type: "rectangle", x1: x, y1: 10, x2: x + 50, y2: 60 }) as unknown as Element;
  const board = new Map([
    ["mine", box("mine", 10)],
    ["theirs", box("theirs", 600)],
  ]);
  const plan = (shown: Element[], hidden: string[] = []) => ({
    shown: new Map(shown.map((element) => [element.id, element])),
    buried: new Map<string, Element>(),
    hidden: new Map(hidden.map((id) => [id, {} as Stamp])),
  });

  it("lets changes inside the frame through", () => {
    const outside = outsideZone(plan([box("mine", 100), box("new", 200)], ["mine"]), (id) => board.get(id), zone);
    assert.deepEqual(outside, { upsert: [], remove: [] });
  });

  it("catches moving something out, adding outside, and touching or removing what's outside", () => {
    const outside = outsideZone(
      plan([box("mine", 380), box("new", 700), box("theirs", 100)], ["theirs"]),
      (id) => board.get(id),
      zone,
    );
    assert.deepEqual(outside, { upsert: ["mine", "new", "theirs"], remove: ["theirs"] });
  });

  it("catches everything when there's no frame, and any frame", () => {
    assert.deepEqual(outsideZone(plan([box("new", 10)]), () => undefined, null).upsert, ["new"]);
    const frame = { ...frames.get("f2")!, id: "f3", x1: 10, x2: 20, y1: 10, y2: 20 };
    assert.deepEqual(outsideZone(plan([frame]), () => undefined, zone).upsert, ["f3"]);
  });
});
