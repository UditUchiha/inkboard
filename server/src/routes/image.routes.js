import { pipeline } from "node:stream";
import { Router } from "express";
import { env } from "../config/env.ts";
import { openImage } from "../services/image-storage.ts";

const router = Router();

// Images are fetched by <img> tags, which can't send a login token, so access is
// by knowing the image's random id (see image-storage.js). An image never changes
// under its id, but a link can't be taken back once it's out, so copies are kept only in
// the viewer's own browser (not shared caches or CDNs) and only for a day: a removed
// picture stops showing soon after, rather than staying cached for a year.
const CACHE_CONTROL = "private, max-age=86400, immutable";
async function sendImage(req, res, next, { small = false } = {}) {
  try {
    const image = await openImage(req.params.imageId, { small });
    if (!image) return res.status(404).json({ error: "That image doesn't exist." });
    // The stored file is only read once asked for, so the first piece is read before anything is
    // sent: a file that can't be read (its chunks missing, say) still gets an error answer then.
    // (A file with no chunks left at all reads as empty rather than failing, so that counts too.)
    const pieces = image.stream[Symbol.asyncIterator]();
    const first = await pieces.next();
    if (first.done && image.size > 0) throw new Error(`Stored image ${req.params.imageId} has lost its data.`);

    res.set({
      "Content-Type": image.mime ?? "application/octet-stream",
      "Content-Length": String(image.size),
      "Cache-Control": CACHE_CONTROL,
      // Other sites may not embed pictures, unless the app itself is on another address, which has
      // to be able to: CLIENT_ORIGIN, or outside production the Vite dev server (see env.js).
      "Cross-Origin-Resource-Policy": env.clientOrigins.length > 0 ? "cross-origin" : "same-origin",
    });
    async function* rest() {
      if (!first.done) yield first.value;
      for (let piece = await pieces.next(); !piece.done; piece = await pieces.next()) yield piece.value;
    }
    // Once the picture is on its way, an error can only cut the response off, which pipeline does.
    // Either way the stored file is closed, also when the download is cut off.
    pipeline(rest, res, () => pieces.return().catch(() => {}));
  } catch (error) {
    next(error);
  }
}

router.get("/:imageId", (req, res, next) => sendImage(req, res, next));
// The small copy thumbnails draw from; the full image for images that have none.
router.get("/:imageId/small", (req, res, next) => sendImage(req, res, next, { small: true }));

export default router;
