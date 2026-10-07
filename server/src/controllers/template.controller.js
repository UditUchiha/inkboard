import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { Template } from "../models/template.model.js";
import { getLiveElements } from "../realtime/index.js";
import { findBoardForMember } from "../services/boards.js";

const MAX_TEMPLATES = 30;

const serializeTemplate = (template) => ({
  id: template.id,
  title: template.title,
  elements: template.elements,
  createdAt: template.createdAt,
});

export async function listTemplates(req, res) {
  const templates = await Template.find({ owner: req.userId }).sort({ createdAt: -1 });
  res.json({ templates: templates.map(serializeTemplate) });
}

/** Saves a copy of a board's current drawings as a template for new boards. */
export async function createTemplate(req, res) {
  const board = await findBoardForMember(String(req.body?.boardId ?? ""), req.userId);
  const title = String(req.body?.title ?? "").trim() || board.title;
  if (title.length > 60) throw new HttpError(400, "Use 60 characters or fewer for the name.");

  // Images belong to the board they were added to and go when it does, so a
  // template (which outlives the board) can't carry them.
  const everything = getLiveElements(board.id) ?? board.elements;
  const elements = everything.filter((element) => element.type !== "image");
  if (elements.length === 0) {
    throw new HttpError(
      400,
      everything.length > 0
        ? "Templates can't hold images, and this board has nothing else on it. Draw something first."
        : "Draw something first. An empty board makes an empty template.",
    );
  }
  if ((await Template.countDocuments({ owner: req.userId })) >= MAX_TEMPLATES) {
    throw new HttpError(400, `You can keep up to ${MAX_TEMPLATES} templates. Delete one to save another.`);
  }

  const template = await Template.create({ owner: req.userId, title, elements });
  res.status(201).json({ template: serializeTemplate(template) });
}

export async function deleteTemplate(req, res) {
  const { templateId } = req.params;
  const result = mongoose.isValidObjectId(templateId)
    ? await Template.deleteOne({ _id: templateId, owner: req.userId })
    : { deletedCount: 0 };
  if (result.deletedCount === 0) throw new HttpError(404, "That template doesn't exist anymore.");
  res.status(204).end();
}
