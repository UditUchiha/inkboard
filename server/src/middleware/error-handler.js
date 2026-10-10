import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.js";

export function notFound(req, res, next) {
  next(new HttpError(404, `No API route matches ${req.method} ${req.originalUrl}.`));
}

const DUPLICATE_KEY = 11000;

export function errorHandler(err, req, res, next) {
  // Too late to send a different answer; let Express close the connection.
  if (res.headersSent) return next(err);

  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const first = Object.values(err.errors)[0];
    return res.status(400).json({ error: first?.message ?? "Some fields are invalid." });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "The request body must be valid JSON." });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "The request is too large." });
  }
  // Two requests racing to create the same unique thing (a sign-up, say): the loser lost fair and square.
  // The error's key values hold personal details, so they're not logged or sent.
  if (err?.code === DUPLICATE_KEY) {
    return res.status(409).json({ error: "That already exists." });
  }
  // Mistakes in the request that other libraries report with a status of their own
  // (a malformed URL, an unsupported Content-Encoding) aren't server faults.
  const status = err?.status ?? err?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ error: "The request couldn't be read." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server. Try again in a moment." });
}
