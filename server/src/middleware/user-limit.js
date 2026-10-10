import { rateLimit } from "express-rate-limit";

/**
 * Limits how often one signed-in person can do something: allows `limit` requests
 * per `windowMs`, then answers 429 with `message`. Put it after requireAuth.
 */
export const limitPerUser = ({ windowMs, limit, message }) =>
  rateLimit({
    windowMs,
    limit,
    keyGenerator: (req) => String(req.userId),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: message },
  });
