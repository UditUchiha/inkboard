import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { eventually, rect, remove, startServer, upsert } from "./helpers.js";

const { env } = await import("../src/config/env.ts");

const { imageBytes } = await import("../src/services/image-storage.js");
const { forgetRecentUploads, IMAGE_LIMITS, sweepsSettled, sweepUnusedImages } =
  await import("../src/services/images.js");

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());
// Rates are per minute, so each test starts with nobody having uploaded lately.
beforeEach(() => forgetRecentUploads());

// The smallest headers of each kind that say how big the picture is (16 by 16 unless told otherwise), padded
// so they pass the "is this a picture" check. They can't be drawn, but the server only reads the header.
const u32 = (value) => Buffer.from(value.toString(16).padStart(8, "0"), "hex");
const u16le = (value) => Buffer.from([value & 255, value >> 8]);
const u24le = (value) => Buffer.from([value & 255, (value >> 8) & 255, value >> 16]);
const png = (extra = 0, [width, height] = [16, 16]) =>
  Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    u32(width),
    u32(height),
    Buffer.alloc(extra, 1),
  ]);
const jpeg = ([width, height] = [16, 16]) =>
  Buffer.concat([
    Buffer.from("ffd8ffc0001108", "hex"),
    Buffer.from([height >> 8, height & 255, width >> 8, width & 255]),
    Buffer.from("03011100021100031100", "hex"),
  ]);
const gif = ([width, height] = [16, 16]) =>
  Buffer.concat([Buffer.from("474946383961", "hex"), u16le(width), u16le(height), Buffer.alloc(8, 3)]);
const webp = ([width, height] = [16, 16]) =>
  Buffer.concat([
    Buffer.from("52494646", "hex"),
    Buffer.alloc(4),
    Buffer.from("57454250", "hex"),
    Buffer.from("56503858", "hex"), // VP8X
    Buffer.alloc(8),
    u24le(width - 1),
    u24le(height - 1),
  ]);

const setLink = (user, boardId, linkAccess) =>
  app.request(`/boards/${boardId}/link-access`, { method: "PATCH", user, body: { linkAccess } });

const picture = (imageId, id = "pic") => ({ id, type: "image", imageId, x1: 0, y1: 0, x2: 200, y2: 100 });
const imageUrl = (id) => `${app.url}/api/images/${id}`;

const ok = (reply) => (assert.equal(reply.ok, true, reply.error), reply.id);
const status = async (id) => (await fetch(imageUrl(id))).status;

// Runs `fn` with some image limits lowered, so tests don't need hundreds of MB.
async function withLimits(changes, fn) {
  const saved = { ...IMAGE_LIMITS };
  Object.assign(IMAGE_LIMITS, changes);
  try {
    return await fn();
  } finally {
    Object.assign(IMAGE_LIMITS, saved);
  }
}

async function ownerOnBoard() {
  const owner = await app.signUp("Owner");
  const boardId = await app.createBoard(owner);
  const client = await app.connect(owner);
  await client.join(boardId);
  return { owner, boardId, client };
}

describe("uploading images", () => {
  it("stores an image and serves exactly the same bytes back, cacheable for good", async () => {
    const { boardId, client } = await ownerOnBoard();
    const file = png(5000);
    const reply = await client.image(boardId, file);
    assert.equal(reply.ok, true);
    assert.match(reply.id, /^[a-f0-9]{32}$/);

    const response = await fetch(imageUrl(reply.id));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.match(response.headers.get("cache-control"), /immutable/);
    assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), file);
  });

  it("accepts PNG, JPEG, GIF and WebP, labelled by what they really are", async () => {
    const { boardId, client } = await ownerOnBoard();
    for (const [file, type] of [
      [png(), "image/png"],
      [jpeg(), "image/jpeg"],
      [gif(), "image/gif"],
      [webp(), "image/webp"],
    ]) {
      const { id } = await client.image(boardId, file);
      assert.equal((await fetch(imageUrl(id))).headers.get("content-type"), type);
    }
  });

  it("refuses anything that isn't one of those, whatever it claims to be", async () => {
    const { boardId, client } = await ownerOnBoard();
    const script = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const data of [script, Buffer.from("just some text, not a picture at all"), Buffer.alloc(0)]) {
      assert.equal((await client.image(boardId, data)).ok, false);
    }
    assert.equal((await client.image(boardId, "a string, not bytes")).ok, false);
  });

  it("refuses an image over the size limit", async () => {
    const { boardId, client } = await ownerOnBoard();
    const reply = await client.image(boardId, png(2_100_000));
    assert.equal(reply.ok, false);
    assert.equal(reply.tooLarge, true);
  });

  it("refuses pictures that declare too many pixels, whatever their file size", async () => {
    const { boardId, client } = await ownerOnBoard();
    const side = IMAGE_LIMITS.side;
    for (const bomb of [
      png(0, [30000, 30000]),
      png(0, [side + 1, 16]),
      jpeg([16, 30000]),
      gif([30000, 16]),
      webp([side + 1, 16]),
    ]) {
      const reply = await client.image(boardId, bomb);
      assert.equal(reply.ok, false);
      assert.match(reply.error, /too large/);
    }
    // At the limit is fine, and so is every format's header being read.
    ok(await client.image(boardId, png(0, [side, side])));
    ok(await client.image(boardId, jpeg([side, 16])));
    ok(await client.image(boardId, gif([side, 16])));
  });

  it("refuses pictures whose header doesn't say how big they are", async () => {
    const { boardId, client } = await ownerOnBoard();
    const noHeader = Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(8, 2)]);
    const reply = await client.image(boardId, noHeader);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /couldn't be read/);
  });

  it("drops a small copy with too many pixels, but keeps the image", async () => {
    const { boardId, client } = await ownerOnBoard();
    const full = png(1000);
    const id = ok(await client.image(boardId, full, png(0, [IMAGE_LIMITS.smallSide + 1, 16])));
    assert.equal((await fetch(`${imageUrl(id)}/small`)).headers.get("content-length"), String(full.length));
  });

  it("slows down an account that uploads many pictures in a minute", async () => {
    const { boardId, client } = await ownerOnBoard();
    await withLimits({ uploadsPerMinute: 3 }, async () => {
      for (let index = 0; index < 3; index += 1) ok(await client.image(boardId, png()));
      const reply = await client.image(boardId, png());
      assert.equal(reply.ok, false);
      assert.match(reply.error, /too quickly/);
    });
  });

  it("stops a board from filling the database with images", async () => {
    const { boardId, client } = await ownerOnBoard();
    let stored = 0;
    let reply;
    for (; stored < 20; stored += 1) {
      reply = await client.image(boardId, png(1_900_000));
      if (!reply.ok) break;
    }
    assert.equal(reply.ok, false);
    assert.equal(reply.full, "board");
    assert.ok(stored >= 10 && stored <= 14, `stored ${stored} images before the limit`);
  });

  it("limits the images across all the boards one person owns, whoever adds them", async () => {
    const { owner, boardId, client } = await ownerOnBoard();
    const second = await app.createBoard(owner);
    await withLimits({ owner: 250_000 }, async () => {
      ok(await client.image(boardId, png(100_000)));
      await client.join(second);
      ok(await client.image(second, png(100_000)));
      const reply = await client.image(second, png(100_000));
      assert.equal(reply.full, "owner");
      assert.match(reply.error, /Your boards are out of image space/);
    });
  });

  it("gives an account whose email address nobody has confirmed a smaller share, once email is set up", async () => {
    const stranger = await app.signUp("Stranger", { verified: false });
    const verified = await app.signUp("Verified");
    const open = async (user) => {
      const boardId = await app.createBoard(user);
      const client = await app.connect(user);
      await client.join(boardId);
      return { boardId, client };
    };
    const first = await open(stranger);
    const second = await open(verified);
    const saved = { ...env.email };
    try {
      env.email.brevoApiKey = "key";
      env.email.from = "ink@example.test";
      await withLimits({ owner: 250_000, unverifiedOwner: 150_000 }, async () => {
        ok(await first.client.image(first.boardId, png(100_000)));
        const refused = await first.client.image(first.boardId, png(100_000));
        assert.equal(refused.full, "owner");
        assert.match(refused.error, /Confirm your email address/);

        ok(await second.client.image(second.boardId, png(100_000)));
        ok(await second.client.image(second.boardId, png(100_000)));
        const verifiedRefused = await second.client.image(second.boardId, png(100_000));
        assert.equal(verifiedRefused.full, "owner");
        assert.doesNotMatch(verifiedRefused.error, /Confirm your email/);
      });
    } finally {
      Object.assign(env.email, saved);
    }
    // With no email set up, nobody can confirm an address, so nobody is held to the smaller share.
    await withLimits({ unverifiedOwner: 1 }, async () => ok(await first.client.image(first.boardId, png(1000))));
  });

  it("slows down one network address however many accounts are behind it", async () => {
    const a = await ownerOnBoard();
    const b = await ownerOnBoard();
    await withLimits({ uploadsPerMinutePerAddress: 3 }, async () => {
      ok(await a.client.image(a.boardId, png()));
      ok(await b.client.image(b.boardId, png()));
      ok(await a.client.image(a.boardId, png()));
      const reply = await b.client.image(b.boardId, png());
      assert.equal(reply.ok, false);
      assert.match(reply.error, /too quickly/);
    });
  });

  it("stops images filling the whole database, across everyone", async () => {
    const { boardId, client } = await ownerOnBoard();
    await withLimits({ total: (await imageBytes()) + 150_000 }, async () => {
      ok(await client.image(boardId, png(100_000)));
      assert.equal((await client.image(boardId, png(100_000))).full, "total");
    });
  });

  it("doesn't let uploads sent at the same moment squeeze past a limit together", async () => {
    const { boardId, client } = await ownerOnBoard();
    await withLimits({ board: 350_000 }, async () => {
      const replies = await Promise.all(Array.from({ length: 6 }, () => client.image(boardId, png(100_000))));
      assert.equal(replies.filter((reply) => reply.ok).length, 3);
    });
  });

  it("keeps a small copy for thumbnails, and serves the image itself when there is none", async () => {
    const { boardId, client } = await ownerOnBoard();
    const full = png(50_000);
    const small = webp();
    const withSmall = ok(await client.image(boardId, full, small));
    assert.deepEqual(Buffer.from(await (await fetch(`${imageUrl(withSmall)}/small`)).arrayBuffer()), small);
    assert.deepEqual(Buffer.from(await (await fetch(imageUrl(withSmall))).arrayBuffer()), full);

    const without = ok(await client.image(boardId, full));
    assert.deepEqual(Buffer.from(await (await fetch(`${imageUrl(without)}/small`)).arrayBuffer()), full);
  });

  it("drops a small copy that isn't a picture or is too big, but keeps the image", async () => {
    const { boardId, client } = await ownerOnBoard();
    for (const small of [Buffer.from("not a picture, just some words"), png(300_000)]) {
      const id = ok(await client.image(boardId, png(), small));
      assert.equal((await fetch(`${imageUrl(id)}/small`)).headers.get("content-length"), String(png().length));
    }
  });

  it("answers with an error, rather than dropping the connection, for a stored image that can't be read", async () => {
    const { boardId, client } = await ownerOnBoard();
    const { db } = mongoose.connection;
    const lose = async (id, chunks) => {
      const file = await db.collection("images.files").findOne({ filename: id });
      await db.collection("images.chunks").deleteMany({ files_id: file._id, ...chunks });
    };
    const expectError = async (id) => {
      const response = await fetch(imageUrl(id));
      assert.equal(response.status, 500);
      assert.match((await response.json()).error, /went wrong/);
    };
    // Bigger than one 255 KB chunk, with its first chunk gone: reading it fails.
    const firstLost = ok(await client.image(boardId, png(300_000)));
    await lose(firstLost, { n: 0 });
    await expectError(firstLost);
    // Every chunk gone: reading it finds nothing at all.
    const allLost = ok(await client.image(boardId, png()));
    await lose(allLost, {});
    await expectError(allLost);
  });

  it("answers 404 for an image that doesn't exist and for a malformed id", async () => {
    assert.equal((await fetch(imageUrl("0".repeat(32)))).status, 404);
    assert.equal((await fetch(imageUrl("not-an-id"))).status, 404);
  });
});

describe("who can upload", () => {
  it("lets invited editors and people with an edit link, guests included, but never viewers", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const boardId = await app.createBoard(owner);
    await app.request(`/boards/${boardId}/collaborators`, {
      method: "POST",
      user: owner,
      body: { email: editor.email },
    });

    const asEditor = await app.connect(editor);
    await asEditor.join(boardId);
    assert.equal((await asEditor.image(boardId, png())).ok, true);

    await setLink(owner, boardId, "view");
    const guest = await app.connect(null, { guest: { id: "g_abcdef1", name: "Visitor" } });
    await guest.join(boardId);
    const refused = await guest.image(boardId, png());
    assert.equal(refused.ok, false);
    assert.equal(refused.readOnly, true);

    await setLink(owner, boardId, "edit");
    await eventually(() => guest.last("board:role")?.role === "contributor", {
      message: "guest becoming a contributor",
    });
    assert.equal((await guest.image(boardId, png())).ok, true);
  });

  it("refuses an upload from someone who hasn't joined the board", async () => {
    const { boardId } = await ownerOnBoard();
    const outsider = await app.connect(await app.signUp("Outsider"));
    assert.equal((await outsider.image(boardId, png())).ok, false);
  });
});

describe("image elements on a board", () => {
  it("syncs an image element to other people and keeps it after a reload", async () => {
    const { owner, boardId, client } = await ownerOnBoard();
    const watcher = await app.connect(owner);
    await watcher.join(boardId);

    const { id } = await client.image(boardId, png());
    assert.equal((await client.op(boardId, upsert(picture(id)))).ok, true);
    await eventually(() => watcher.of("board:op").length > 0, { message: "the image reaching the other screen" });
    assert.equal(watcher.of("board:op")[0].op.upsert[0].imageId, id);

    await eventually(
      async () => {
        const reopened = await (await app.connect(owner)).join(boardId);
        return reopened.board.elements.some((element) => element.imageId === id);
      },
      { timeout: 8000, message: "the image element being saved" },
    );
  });

  it("drops image elements that don't name a real image id", async () => {
    const { boardId, client } = await ownerOnBoard();
    const bad = [
      picture("../../etc/passwd"),
      picture(undefined),
      picture("short"),
      { ...picture("a".repeat(32)), imageId: 5 },
    ];
    for (const element of bad) assert.equal((await client.op(boardId, upsert(element))).ok, false);
    assert.equal((await client.op(boardId, upsert(picture("a".repeat(32))))).ok, true);
  });

  it("deletes a board's images when the board is deleted for good", async () => {
    const { owner, boardId, client } = await ownerOnBoard();
    const { id } = await client.image(boardId, png());
    assert.equal((await fetch(imageUrl(id))).status, 200);

    assert.equal((await app.request(`/boards/${boardId}`, { method: "DELETE", user: owner })).status, 204);
    assert.equal((await app.request(`/boards/${boardId}/permanent`, { method: "DELETE", user: owner })).status, 204);
    await eventually(async () => (await fetch(imageUrl(id))).status === 404, { message: "the image being removed" });
  });

  it("explains why a board with only images can't become a template", async () => {
    const { owner, boardId, client } = await ownerOnBoard();
    await client.op(boardId, upsert(picture(ok(await client.image(boardId, png())))));
    const { status: code, data } = await app.request("/templates", {
      method: "POST",
      user: owner,
      body: { boardId, title: "T" },
    });
    assert.equal(code, 400);
    assert.match(data.error, /can't hold images/);
  });

  it("leaves images out of templates, since templates outlive the board", async () => {
    const { owner, boardId, client } = await ownerOnBoard();
    const { id } = await client.image(boardId, png());
    await client.op(boardId, upsert(picture(id), rect("box")));

    const { status, data } = await app.request("/templates", {
      method: "POST",
      user: owner,
      body: { boardId, title: "T" },
    });
    assert.equal(status, 201);
    assert.equal(data.template.elementCount, 1);
    assert.deepEqual(
      data.template.preview.map((element) => element.type),
      ["rectangle"],
    );
  });
});

describe("cleaning up images nothing shows", () => {
  it("deletes old images that neither the board nor its versions show, and keeps the rest", async () => {
    const { owner, boardId, client } = await ownerOnBoard();
    const placed = ok(await client.image(boardId, png()));
    const unused = ok(await client.image(boardId, png(), webp()));
    const inVersion = ok(await client.image(boardId, png()));
    await client.op(boardId, upsert(picture(placed, "a"), picture(inVersion, "b")));
    const saved = await app.request(`/boards/${boardId}/versions`, {
      method: "POST",
      user: owner,
      body: { label: "V" },
    });
    assert.equal(saved.status, 201);
    await client.op(boardId, remove("b"));

    // Just uploaded, so even the unused one is kept: it may be about to be placed, or brought back by undo.
    assert.equal(await sweepUnusedImages({ boards: [boardId] }), 0);

    assert.equal(await sweepUnusedImages({ boards: [boardId], uploadedBefore: new Date(Date.now() + 1000) }), 1);
    assert.equal(await status(unused), 404);
    assert.equal((await fetch(`${imageUrl(unused)}/small`)).status, 404);
    assert.equal(await status(placed), 200);
    assert.equal(await status(inVersion), 200);
  });

  it("makes room by sweeping pictures nothing shows when a board runs out, outside the upload", async () => {
    const { boardId, client } = await ownerOnBoard();
    await withLimits({ board: 250_000, keepUnusedForMs: 0 }, async () => {
      const unused = ok(await client.image(boardId, png(100_000)));
      const placed = ok(await client.image(boardId, png(100_000)));
      await client.op(boardId, upsert(picture(placed, "a")));

      // The upload that runs out is answered straight away; the sweep it starts runs after.
      assert.equal((await client.image(boardId, png(100_000))).full, "board");
      await sweepsSettled();
      assert.equal(await status(unused), 404);
      assert.equal(await status(placed), 200);
      ok(await client.image(boardId, png(100_000)));
    });
  });

  it("still refuses when every picture is in use", async () => {
    const { boardId, client } = await ownerOnBoard();
    await withLimits({ board: 250_000, keepUnusedForMs: 0 }, async () => {
      const first = ok(await client.image(boardId, png(100_000)));
      const second = ok(await client.image(boardId, png(100_000)));
      await client.op(boardId, upsert(picture(first, "a"), picture(second, "b")));
      assert.equal((await client.image(boardId, png(100_000))).full, "board");
    });
  });

  it("doesn't sweep for the same owner again right after a sweep that freed nothing", async () => {
    const { boardId, client } = await ownerOnBoard();
    await withLimits({ board: 250_000, keepUnusedForMs: 0, sweepEveryMs: 60_000 }, async () => {
      const first = ok(await client.image(boardId, png(100_000)));
      const second = ok(await client.image(boardId, png(100_000)));
      await client.op(boardId, upsert(picture(first, "a"), picture(second, "b")));
      assert.equal((await client.image(boardId, png(100_000))).full, "board"); // swept, nothing to free
      await sweepsSettled();

      await client.op(boardId, remove("a"));
      assert.equal((await client.image(boardId, png(100_000))).full, "board"); // too soon to sweep again
      await sweepsSettled();
      assert.equal(await status(first), 200);
    });
  });
});
