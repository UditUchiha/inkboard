import { pipeline } from "node:stream";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.ts";
import { openImage } from "../services/image-storage.ts";

const router = Router();

// <img> tags can't send a login token, so access is by knowing the random id (see image-storage.ts). A link can't be
// taken
// back once out, so copies are cached only in the viewer's own browser (not shared caches or CDNs) for a day: a removed
// picture stops showing soon after.
const CACHE_CONTROL = "private, max-age=86400, immutable";
async function sendImage(
  req: Request<{ imageId: string }>,
  res: Response,
  next: NextFunction,
  { small = false }: { small?: boolean } = {},
) {
  try {
    const image = await openImage(req.params.imageId, { small });
    if (!image) return res.status(404).json({ error: "That image doesn't exist." });
    // the first piece is read before anything is sent, so a file that can't be read (chunks missing) still gets an
    // error answer; one with no chunks reads as empty
    const pieces = image.stream[Symbol.asyncIterator]();
    const first = await pieces.next();
    if (first.done && image.size > 0) throw new Error(`Stored image ${req.params.imageId} has lost its data.`);

    res.set({
      "Content-Type": image.mime ?? "application/octet-stream",
      "Content-Length": String(image.size),
      "Cache-Control": CACHE_CONTROL,
      // other sites may not embed pictures, unless the app is on another address: CLIENT_ORIGIN, or outside production
      // the Vite dev server
      "Cross-Origin-Resource-Policy": env.clientOrigins.length > 0 ? "cross-origin" : "same-origin",
    });
    async function* rest(): AsyncGenerator<Buffer> {
      if (!first.done) yield first.value;
      for (let piece = await pieces.next(); !piece.done; piece = await pieces.next()) yield piece.value;
    }
    // once the picture is on its way an error can only cut the response off, which pipeline does; the stored file is
    // closed either way
    pipeline(rest, res, () => pieces.return!().catch(() => {}));
  } catch (error) {
    next(error);
  }
}

router.get("/:imageId", (req, res, next) => sendImage(req, res, next));
router.get("/:imageId/small", (req, res, next) => sendImage(req, res, next, { small: true }));

export default router;
