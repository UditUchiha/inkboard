import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { BoardReply } from "@inkboard/shared/api";
import mongoose from "mongoose";
import { eventually, startServer, upsert } from "./helpers.ts";
import type { ServerInstance } from "./helpers.ts";

const { env } = await import("../src/config/env.ts");
const { moveImagesToR2 } = await import("../src/services/image-storage.ts");
const { forgetRecentUploads } = await import("../src/services/images.ts");

// A stand-in for R2's S3 API: objects by path, and the requests made, so tests see what was sent where.
const objects = new Map<string, { body: Buffer; type: string | null }>();
const requests: { method: string; path: string; signed: boolean }[] = [];
const realFetch = globalThis.fetch;
const R2_HOST = "account.r2.cloudflarestorage.com";

async function fakeR2(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.host !== R2_HOST) return realFetch(input, init);
  const path = decodeURIComponent(url.pathname);
  requests.push({
    method: request.method,
    path,
    signed: /^AWS4-HMAC-SHA256 Credential=key\//.test(request.headers.get("authorization") ?? ""),
  });
  if (request.method === "PUT") {
    objects.set(path, { body: Buffer.from(await request.arrayBuffer()), type: request.headers.get("content-type") });
    return new Response(null, { status: 200 });
  }
  if (request.method === "DELETE") {
    objects.delete(path);
    return new Response(null, { status: 204 });
  }
  const object = objects.get(path);
  return object ? new Response(new Uint8Array(object.body), { status: 200 }) : new Response(null, { status: 404 });
}

const R2 = { accountId: "account", accessKeyId: "key", secretAccessKey: "secret", bucket: "pictures" };

let app: ServerInstance;
before(async () => {
  app = await startServer();
  globalThis.fetch = fakeR2 as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  env.r2 = null;
  await app.stop();
});
beforeEach(() => {
  forgetRecentUploads();
  env.r2 = R2;
  requests.length = 0;
});

// The smallest PNG header that says how big the picture is (16 by 16), padded: the server only reads the header.
const png = (extra = 0) =>
  Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d494844520000001000000010", "hex"), Buffer.alloc(extra, 1)]);
const imageUrl = (id: string) => `${app.url}/api/images/${id}`;
const files = () => mongoose.connection.db!.collection("images.files");
const chunks = () => mongoose.connection.db!.collection("images.chunks");

async function ownerOnBoard() {
  const owner = await app.signUp("Owner");
  const boardId = await app.createBoard(owner);
  const client = await app.connect(owner);
  await client.join(boardId);
  return { owner, boardId, client };
}

describe("images in R2", () => {
  it("keeps new images' bytes in R2 and serves them from there", async () => {
    const { boardId, client } = await ownerOnBoard();
    const file = png(4000);
    const reply = await client.image(boardId, file, png(10));
    assert.equal(reply.ok, true, reply.error);

    assert.deepEqual(objects.get(`/pictures/images/${reply.id}`), { body: file, type: "image/png" });
    assert.ok(objects.has(`/pictures/images/${reply.id}.small`), "the small copy goes too");
    assert.ok(
      requests.every((request) => request.signed),
      "every request is signed for S3",
    );
    const entry = await files().findOne({ filename: reply.id });
    assert.equal(entry!.storage, "r2");
    assert.equal(await chunks().countDocuments({ files_id: entry!._id }), 0, "nothing in the database's chunks");

    const response = await realFetch(imageUrl(reply.id));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), file);
    assert.equal((await realFetch(`${imageUrl(reply.id)}/small`)).status, 200);
  });

  it("deletes the objects with the board, and copies them with the board", async () => {
    const { owner, boardId, client } = await ownerOnBoard();
    const { id } = await client.image(boardId, png(100));
    await client.op(boardId, upsert({ id: "pic", type: "image", imageId: id, x1: 0, y1: 0, x2: 10, y2: 10 }));

    const copy = await app.request<BoardReply>(`/boards/${boardId}/copy`, { method: "POST", user: owner });
    const copiedId = (copy.data.board.elements[0] as { imageId: string }).imageId;
    assert.notEqual(copiedId, id);
    assert.deepEqual(objects.get(`/pictures/images/${copiedId}`)!.body, png(100));

    await app.request(`/boards/${boardId}`, { method: "DELETE", user: owner });
    await app.request(`/boards/${boardId}/permanent`, { method: "DELETE", user: owner });
    await eventually(async () => !objects.has(`/pictures/images/${id}`), { message: "the object being deleted" });
    assert.equal(await files().countDocuments({ filename: id }), 0);
    assert.ok(objects.has(`/pictures/images/${copiedId}`), "the copy's picture stays");
  });

  it("still serves images from before R2, and moves them over without losing any", async () => {
    const { boardId, client } = await ownerOnBoard();
    env.r2 = null;
    const old = png(700_000); // more than one GridFS chunk
    const { id } = await client.image(boardId, old, png(20));
    env.r2 = R2;
    assert.equal(objects.has(`/pictures/images/${id}`), false);
    assert.deepEqual(Buffer.from(await (await realFetch(imageUrl(id))).arrayBuffer()), old, "served from GridFS");

    const moved = await moveImagesToR2();
    assert.ok(moved >= 2, "the image and its small copy");
    assert.deepEqual(objects.get(`/pictures/images/${id}`)!.body, old);
    const entry = await files().findOne({ filename: id });
    assert.equal(entry!.storage, "r2");
    assert.equal(await chunks().countDocuments({ files_id: entry!._id }), 0);
    assert.deepEqual(Buffer.from(await (await realFetch(imageUrl(id))).arrayBuffer()), old, "served from R2");
    assert.equal(await moveImagesToR2(), 0, "a second run has nothing left to move");
  });

  it("answers with an error, not a broken picture, when R2 has lost an object", async () => {
    const { boardId, client } = await ownerOnBoard();
    const { id } = await client.image(boardId, png(100));
    objects.delete(`/pictures/images/${id}`);
    assert.equal((await realFetch(imageUrl(id))).status, 500);
  });
});
