import { eventually, rect, startServer, upsert } from "./helpers.ts"; // first: it sets up the environment
import type { ServerInstance, TestClient, TestOpReply } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ApiTokenCreatedReply } from "@inkboard/shared/api";
import type { Classroom, ClassroomMessage } from "@inkboard/shared/socket";
import type { Element, FrameElement } from "@inkboard/shared/types";
import { Board } from "../src/models/board.model.ts";
import { flushAllSessions } from "../src/realtime/index.ts";

let app: ServerInstance;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const frame = (id: string, x: number): FrameElement => ({
  id,
  type: "frame",
  x1: x,
  y1: 0,
  x2: x + 400,
  y2: 300,
  name: id,
});
const seen = (client: TestClient) => (client.last("classroom") as ClassroomMessage | undefined)?.classroom;
const act = (client: TestClient, payload: unknown) =>
  new Promise<{ ok: boolean }>((resolve) => client.socket.emit("classroom", payload, resolve));
type Reply = TestOpReply & { restored?: Element[]; outside?: true; cleaned?: Element[]; dropped?: string[] };

/**
 * A teacher's board with two frames (f1, f2) and a box of the teacher's outside them, its link set to let anyone
 * edit, and two students on it as guests.
 */
async function classroom() {
  const teacher = await app.signUp("Teacher");
  const id = await app.createBoard(teacher);
  await app.request(`/boards/${id}/link-access`, { method: "PATCH", user: teacher, body: { linkAccess: "edit" } });
  const host = await app.connect(teacher);
  await host.join(id);
  await host.op(id, upsert(frame("f1", 0), frame("f2", 500), rect("theirs", 1000, 0)));
  const asha = await app.connect(null, { guest: { id: "g_asha01", name: "Asha" } });
  const ben = await app.connect(null, { guest: { id: "g_ben001", name: "Ben" } });
  await asha.join(id);
  await ben.join(id);
  return { teacher, id, host, asha, ben };
}

/** The board as it is now, by id. */
async function board(client: TestClient, id: string) {
  const reply = (await client.join(id)) as { board: { elements: Element[] } };
  return new Map(reply.board.elements.map((element) => [element.id, element]));
}

describe("classroom mode", () => {
  it("is started by a member, and tells each person whether they're a student", async () => {
    const { host, asha } = await classroom();
    assert.equal((await act(asha, { action: "start" })).ok, false, "a student can't start it");
    assert.equal((await act(host, { action: "start" })).ok, true);
    await eventually(() => seen(asha)?.on, { message: "the student told" });
    assert.equal(seen(asha)!.restricted, true);
    assert.equal(seen(host)!.restricted, false);
  });

  it("gives each student one empty frame, which everyone sees claimed", async () => {
    const { host, asha, ben } = await classroom();
    await act(host, { action: "start" });
    assert.equal((await act(asha, { action: "claim", frameId: "f1" })).ok, true);
    assert.equal((await act(ben, { action: "claim", frameId: "f1" })).ok, false, "taken");
    assert.equal((await act(asha, { action: "claim", frameId: "f2" })).ok, false, "she has one");
    assert.equal((await act(host, { action: "claim", frameId: "f2" })).ok, false, "the teacher doesn't claim");
    assert.equal((await act(ben, { action: "claim", frameId: "theirs" })).ok, false, "not a frame");
    assert.equal((await act(ben, { action: "claim", frameId: "f2" })).ok, true);
    await eventually(() => seen(host)?.claims.length === 2, { message: "both claims" });
    const claims = (client: TestClient) => (seen(client) as Classroom).claims;
    assert.deepEqual(
      claims(host).map(({ frameId, name, mine }) => [frameId, name, mine]),
      [
        ["f1", "Asha", false],
        ["f2", "Ben", false],
      ],
    );
    await eventually(() => claims(asha).find((claim) => claim.frameId === "f1")?.mine === true, {
      message: "hers, to her",
    });
  });

  it("takes in a student's changes inside their frame, and sends back what they did outside it", async () => {
    const { id, host, asha, ben } = await classroom();
    await act(host, { action: "start" });
    await act(asha, { action: "claim", frameId: "f1" });
    await act(ben, { action: "claim", frameId: "f2" });
    await ben.op(id, upsert(rect("bens", 600, 10)));

    const inside = (await asha.op(id, upsert(rect("hers", 10, 10)))) as Reply;
    assert.equal(inside.outside, undefined);
    const mixed = (await asha.op(id, {
      upsert: [rect("hers2", 20, 20), rect("stray", 700, 10), { ...rect("theirs", 50, 50) }],
      remove: ["bens"],
    })) as Reply;
    assert.equal(mixed.outside, true);
    assert.deepEqual(mixed.dropped, ["stray"], "a new element outside her frame");
    assert.equal(
      (mixed.cleaned?.find((element) => element.id === "theirs") as { x1: number } | undefined)?.x1,
      1000,
      "the teacher's box as it is",
    );
    assert.equal(mixed.restored?.[0]?.id, "bens", "Ben's box, which she can't remove");

    const now = await board(host, id);
    assert.ok(now.has("hers") && now.has("hers2"), "what was inside went in");
    assert.ok(!now.has("stray") && now.has("bens"));
    assert.equal((now.get("theirs") as { x1: number }).x1, 1000);
  });

  it("doesn't let a student move their frame or a box out of it, or a student without a frame change anything", async () => {
    const { id, host, asha } = await classroom();
    await act(host, { action: "start" });
    const none = (await asha.op(id, upsert(rect("early", 10, 10)))) as Reply;
    assert.deepEqual(none.dropped, ["early"]);
    await act(asha, { action: "claim", frameId: "f1" });
    await asha.op(id, upsert(rect("hers", 10, 10)));
    const moved = (await asha.op(id, upsert({ ...frame("f1", 100) }, rect("hers", 390, 10)))) as Reply;
    assert.deepEqual(moved.cleaned?.map((element) => element.id).sort(), ["f1", "hers"]);
    assert.equal(((await board(host, id)).get("f1") as FrameElement).x1, 0);
  });

  it("leaves members free, and everyone once it's stopped", async () => {
    const { id, host, asha } = await classroom();
    await act(host, { action: "start" });
    assert.equal(((await host.op(id, upsert(rect("anywhere", 2000, 0)))) as Reply).outside, undefined);
    await act(host, { action: "stop" });
    await eventually(() => seen(asha)?.on === false, { message: "stopped" });
    assert.equal(((await asha.op(id, upsert(rect("free", 3000, 0)))) as Reply).outside, undefined);
  });

  it("lets a member free a frame, and shows a student's new name on theirs", async () => {
    const { host, asha } = await classroom();
    await act(host, { action: "start" });
    await act(asha, { action: "claim", frameId: "f1" });
    asha.socket.emit("guest:rename", { name: "Asha K" });
    await eventually(() => seen(host)?.claims[0]?.name === "Asha K", { message: "the new name" });
    assert.equal((await act(asha, { action: "release", frameId: "f1" })).ok, false, "a student can't");
    assert.equal((await act(host, { action: "release", frameId: "f1" })).ok, true);
    await eventually(() => seen(asha)?.claims.length === 0, { message: "freed" });
  });

  it("keeps a student's suggestions in private mode to their frame too", async () => {
    const { id, host, asha } = await classroom();
    await act(host, { action: "start" });
    await act(asha, { action: "claim", frameId: "f1" });
    host.socket.emit("private", { on: true });
    await eventually(() => (asha.last("board:role") as { role?: string } | undefined)?.role === "suggester", {
      message: "suggesting",
    });
    const reply = (await asha.suggest(id, [
      { kind: "add", element: rect("idea", 10, 10) },
      { kind: "add", element: rect("stray", 700, 10) },
      { kind: "remove", target: "theirs" },
    ])) as { ok: boolean; suggestions: { kind: string }[]; dropped?: string[] };
    assert.equal(reply.ok, true);
    assert.equal(reply.suggestions.length, 1);
    assert.deepEqual(reply.dropped?.sort(), ["stray", "theirs"]);
  });

  it("doesn't let someone take a student's frame by going by their id", async () => {
    const { id, host, asha } = await classroom();
    await act(host, { action: "start" });
    await act(asha, { action: "claim", frameId: "f1" });
    // Asha's id is shown to everyone; her key isn't.
    const impostor = await app.connect(null, { guest: { id: "g_asha01", name: "Asha", key: "not-ashas-key-1234" } });
    const joined = (await impostor.join(id)) as { classroom?: Classroom };
    assert.equal(joined.classroom?.claims.find((claim) => claim.frameId === "f1")?.mine, false, "not theirs");
    const reply = (await impostor.op(id, upsert(rect("mine-now", 10, 10)))) as Reply;
    assert.deepEqual(reply.dropped, ["mine-now"], "no frame for them");
    const back = await app.connect(null, { guest: { id: "g_asha01", name: "Asha" } }); // her own browser, with her key
    await back.join(id);
    assert.equal(((await back.op(id, upsert(rect("hers", 10, 10)))) as Reply).outside, undefined);
  });

  it("tells someone invited mid-lesson they're no longer a student, and refuses a student's pictures", async () => {
    const { teacher, id, host, asha } = await classroom();
    await act(host, { action: "start" });
    const image = (await asha.image(id, Buffer.from("not really a picture"))) as { ok: boolean; error?: string };
    assert.equal(image.ok, false);
    assert.match(image.error ?? "", /classroom mode/);
    const student = await app.signUp("Signed In");
    const client = await app.connect(student);
    await client.join(id);
    await app.request(`/boards/${id}/collaborators`, { method: "POST", user: teacher, body: { email: student.email } });
    await eventually(() => seen(client)?.restricted === false, { message: "told they're a teacher now" });
  });

  it("is saved with the board, claims and all", async () => {
    const { teacher, id, host, asha, ben } = await classroom();
    await act(host, { action: "start" });
    await act(asha, { action: "claim", frameId: "f1" });
    for (const client of [host, asha, ben]) client.close();
    await eventually(async () => (await Board.findById(id).select("+classroom").lean())?.classroom, {
      message: "saved",
    });
    await flushAllSessions();
    const back = await app.connect(teacher);
    const reply = (await back.join(id)) as { classroom?: Classroom };
    assert.equal(reply.classroom?.on, true);
    assert.equal(reply.classroom?.claims[0]?.name, "Asha");
  });

  it("holds a non-member writing through the API to their frame, all or nothing", async () => {
    const { id, host } = await classroom();
    await act(host, { action: "start" });
    const student = await app.signUp("Student");
    const created = await app.request<ApiTokenCreatedReply>("/tokens", {
      method: "POST",
      user: student,
      body: { name: "script", scope: "write" },
    });
    const token = { token: created.data.token };
    const write = (x: number) =>
      app.request(`/v1/boards/${id}/elements`, {
        method: "POST",
        user: token,
        body: { elements: [{ type: "rectangle", x, y: 10, width: 20, height: 20 }] },
      });
    assert.equal((await write(10)).status, 403, "no frame yet");
    const socket = await app.connect(student);
    await socket.join(id);
    await act(socket, { action: "claim", frameId: "f2" });
    assert.equal((await write(510)).status, 200, "inside their frame");
    assert.equal((await write(10)).status, 403, "outside it");
    const removed = await app.request(`/v1/boards/${id}/elements`, {
      method: "DELETE",
      user: token,
      body: { ids: ["theirs"] },
    });
    assert.equal(removed.status, 403);
  });
});
