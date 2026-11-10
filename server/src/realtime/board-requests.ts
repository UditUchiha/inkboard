import { canEdit, currentElements, isMemberRole } from "../services/boards.ts";
import type { Role } from "../services/boards.ts";
import { replaySteps } from "../services/replay.ts";
import { Board } from "../models/board.model.ts";
import { detectImageType, IMAGE_LIMITS, storeImage } from "../services/images.ts";
import type { ImageLimit } from "../services/images.ts";
import { getSession } from "./sessions.ts";
import type { RealtimeSocket, SocketLimits } from "./types.ts";
import { personOf, isOnBoard } from "./hub.ts";
import { addressOf } from "./identity.ts";
import { zoneIn } from "./modes.ts";

// Events a browser asks a reply of: uploading an image, and the board's replay.

// optional (thumbnails fall back to the image itself), so a bad one is dropped
function readSmallCopy(data: unknown) {
  if (!Buffer.isBuffer(data) || data.length > IMAGE_LIMITS.small) return null;
  const mime = detectImageType(data);
  return mime ? { buffer: data, mime } : null;
}

function spaceMessage(limit: ImageLimit, role: Role | null, unverified: boolean | undefined) {
  const freeing = "Pictures you remove free their space once no saved version of the board shows them.";
  if (limit === "board") return `This board is out of image space. ${freeing}`;
  if (limit === "owner") {
    if (role === "owner") {
      const verify = unverified ? " Confirm your email address (see Settings) to get more room." : "";
      return `Your boards are out of image space. ${freeing}${verify}`;
    }
    return "This board's owner is out of image space. Ask them to remove pictures they don't need.";
  }
  return "Image storage is full for now. Try again later.";
}

export function registerRequests(socket: RealtimeSocket, limits: SocketLimits) {
  // over the socket, not HTTP, so it's checked like a drawing change: edit-link guests can add images, viewers can't
  socket.on("board:image", async (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const boardId = socket.data.boardId as string;
    if (!isOnBoard(socket, payload?.boardId)) return reply({ ok: false, error: "Open the board first." });
    if (!canEdit(socket.data.role)) return reply({ ok: false, readOnly: true });
    // classroom mode: students add no pictures (docs/classroom-mode.md)
    const open = getSession(boardId);
    if (open && zoneIn(open, personOf(socket).userId, socket.data.boardRole) !== undefined) {
      return reply({ ok: false, error: "In classroom mode, pictures can't be added." });
    }

    const buffer = payload?.data;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0)
      return reply({ ok: false, error: "That file couldn't be read." });
    if (buffer.length > IMAGE_LIMITS.image)
      return reply({ ok: false, tooLarge: true, error: "That image is too big." });
    const mime = detectImageType(buffer);
    if (!mime) return reply({ ok: false, error: "Use a PNG, JPEG, WebP or GIF image." });

    try {
      const small = readSmallCopy(payload!.small);
      const stored: {
        id?: string;
        full?: ImageLimit;
        unverified?: true;
        missing?: true;
        refused?: string;
      } = await storeImage({
        boardId,
        buffer,
        mime,
        small,
        uploadedBy: socket.data.user?.id,
        address: addressOf(socket),
      });
      if (stored.missing) return reply({ ok: false, error: "This board doesn't exist any more." });
      if (stored.refused) return reply({ ok: false, error: stored.refused });
      if (stored.full)
        return reply({
          ok: false,
          full: stored.full,
          error: spaceMessage(stored.full, socket.data.role, stored.unverified),
        });
      reply({ ok: true, id: stored.id! });
    } catch (error) {
      console.error(error);
      reply({ ok: false, error: "The image couldn't be saved. Try again." });
    }
  });

  // members, and link visitors when the owner lets them watch (it shows what was drawn and later removed)
  socket.on("board:replay", async (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const boardId = socket.data.boardId;
    if (!boardId || !isOnBoard(socket, payload?.boardId)) return reply({ ok: false, error: "Open the board first." });
    if (!limits.replay()) return reply({ ok: false, error: "Wait a few seconds and try again." });
    try {
      if (!isMemberRole(socket.data.role)) {
        const board = await Board.findById(boardId).select("linkReplay").lean();
        if (!board?.linkReplay) return reply({ ok: false, error: "Only the board's members can watch its replay." });
      }
      const [steps, elements] = await Promise.all([replaySteps(boardId), currentElements(boardId)]);
      reply({ ok: true, steps, elements });
    } catch (error) {
      console.error(error);
      reply({ ok: false, error: "The replay couldn't be loaded. Try again." });
    }
  });
}
