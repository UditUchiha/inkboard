import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.ts";
import { Template } from "../models/template.model.ts";
import { sanitizeElements } from "../realtime/operations.js";
import { currentElements, drawingBytes, findBoardForMember, withRoom } from "../services/boards.ts";
import { previewElements } from "../services/previews.ts";

// Templates outlive boards and the free database holds 512 MB for everyone, so each one is
// kept small and each person keeps only so many. Tests lower these.
export const TEMPLATE_LIMITS = { count: 30, bytes: 2_000_000 };

// What the New board dialog needs: a light preview to draw, not the drawing. Starting a
// board from a template is done by id (see createBoard), so the drawing never needs to be sent.
const serializeTemplate = (template) => ({
  id: template.id,
  title: template.title,
  elementCount: template.elementCount,
  preview: template.preview,
  createdAt: template.createdAt,
});

// Templates saved before previews were stored get theirs now, once.
async function fillMissingPreviews(templates) {
  const missing = templates.filter((template) => template.preview == null);
  if (missing.length === 0) return;
  const drawings = await Template.find({ _id: { $in: missing.map((template) => template._id) } })
    .select("elements")
    .lean();
  const elementsOf = new Map(drawings.map((drawing) => [String(drawing._id), drawing.elements]));
  for (const template of missing) {
    const elements = elementsOf.get(String(template._id)) ?? [];
    template.elementCount = elements.length;
    template.preview = previewElements(elements);
  }
  await Template.bulkWrite(
    missing.map((template) => ({
      updateOne: {
        filter: { _id: template._id },
        update: { $set: { elementCount: template.elementCount, preview: template.preview } },
      },
    })),
    { timestamps: false },
  );
}

export async function listTemplates(req, res) {
  const templates = await Template.find({ owner: req.userId })
    .sort({ createdAt: -1 })
    .select("title createdAt elementCount preview");
  await fillMissingPreviews(templates);
  res.json({ templates: templates.map(serializeTemplate) });
}

// Images belong to the board they were added to and go when it does, so a template (which
// outlives the board) can't carry them. Lines and arrows that were attached to one are
// let go of it, rather than left pointing at something that isn't there.
function withoutImages(elements) {
  const images = new Set(elements.filter((element) => element.type === "image").map((element) => element.id));
  return elements
    .filter((element) => element.type !== "image")
    .map((element) => {
      const attached = ["start", "end"].filter((end) => images.has(element[`${end}Id`]));
      if (attached.length === 0) return element;
      const released = { ...element };
      for (const end of attached) {
        delete released[`${end}Id`];
        delete released[`${end}Anchor`];
      }
      return released;
    });
}

/** Saves a copy of a board's current drawings as a template for new boards. */
export async function createTemplate(req, res) {
  const board = await findBoardForMember(String(req.body?.boardId ?? ""), req.userId);
  const given = req.body?.title ?? "";
  if (typeof given !== "string") throw new HttpError(400, "The name must be text.");
  // A board's title can be longer than a template's name.
  const title = given.trim() || board.title.slice(0, 60);
  if (title.length > 60) throw new HttpError(400, "Use 60 characters or fewer for the name.");

  const everything = await currentElements(board.id);
  // Held to the same rules as any board's elements: checked and cleaned, with anything too big to store left out.
  const elements = withoutImages(sanitizeElements(everything));
  if (elements.length === 0) {
    throw new HttpError(
      400,
      everything.length > 0
        ? "Templates can't hold images, and this board has nothing else on it. Draw something first."
        : "Draw something first. An empty board makes an empty template.",
    );
  }
  const bytes = drawingBytes(elements);
  if (bytes > TEMPLATE_LIMITS.bytes) {
    throw new HttpError(400, "This board is too big to keep as a template. Try one with fewer drawings.");
  }

  // A template counts towards its owner's space. Checks and writes for one person run one at a
  // time (see withRoom), so two saves sent together can't both pass the count either.
  const template = await withRoom(req.userId, { bytes }, async () => {
    if ((await Template.countDocuments({ owner: req.userId })) >= TEMPLATE_LIMITS.count) {
      throw new HttpError(400, `You can keep up to ${TEMPLATE_LIMITS.count} templates. Delete one to save another.`);
    }
    return Template.create({
      owner: req.userId,
      title,
      elements,
      elementCount: elements.length,
      preview: previewElements(elements),
      bytes,
    });
  });
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
