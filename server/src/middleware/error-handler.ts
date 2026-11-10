import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.ts";

export function notFound(req: Request, res: Response, next: NextFunction) {
  next(new HttpError(404, `No API route matches ${req.method} ${req.originalUrl}.`));
}

const DUPLICATE_KEY = 11000;

// libraries (body-parser, MongoDB, Express itself) put these on errors they throw; anything can be thrown, so every
// field is optional
interface LibraryError {
  type?: string;
  code?: number | string;
  status?: number;
  statusCode?: number;
}

export function errorHandler(err: LibraryError | null | undefined, req: Request, res: Response, next: NextFunction) {
  // too late to send a different answer; let Express close the connection
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
  // two requests racing to create the same unique thing: the loser lost fair and square. The key values hold personal
  // details, so they're not logged or sent.
  if (err?.code === DUPLICATE_KEY) {
    return res.status(409).json({ error: "That already exists." });
  }
  // request mistakes that libraries report with their own status (malformed URL, unsupported Content-Encoding) aren't
  // server faults
  const status = (err?.status ?? err?.statusCode) as number;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ error: "The request couldn't be read." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server. Try again in a moment." });
}
