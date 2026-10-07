import { Router } from "express";
import { openImage } from "../services/image-storage.js";

const router = Router();

// Images are fetched by <img> tags, which can't send a login token, so access is
// by knowing the image's random id (see image-storage.js). An image never changes
// under its id, so browsers and CDNs may keep it for good.
async function sendImage(req, res, next, { small = false } = {}) {
  try {
    const image = await openImage(req.params.imageId, { small });
    if (!image) return res.status(404).json({ error: "That image doesn't exist." });

    res.set({
      "Content-Type": image.mime ?? "application/octet-stream",
      "Content-Length": String(image.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      // Helmet's default blocks other origins from embedding this, which would break
      // the app when the client and server run on different addresses.
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    image.stream.once("error", next);
    image.stream.pipe(res);
  } catch (error) {
    next(error);
  }
}

router.get("/:imageId", (req, res, next) => sendImage(req, res, next));
// The small copy thumbnails draw from; the full image for images that have none.
router.get("/:imageId/small", (req, res, next) => sendImage(req, res, next, { small: true }));

export default router;
