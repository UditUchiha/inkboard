import type * as Api from "@inkboard/shared/api";
import type { Element, ConnectorFields } from "@inkboard/shared/types";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.ts";
import { Template } from "../models/template.model.ts";
import { sanitizeElements } from "../realtime/operations.ts";
import { currentElements, drawingBytes, findBoardForMember, withRoom } from "../services/boards.ts";
import { previewElements } from "../services/previews.ts";

type TemplateDoc = InstanceType<typeof Template>;

// templates outlive boards and the free database holds 512 MB, so each is kept small and each person keeps only so
// many; tests lower these
export const TEMPLATE_LIMITS = { count: 30, bytes: 2_000_000 };

// a light preview to draw, not the drawing: starting a board from a template is by id (see createBoard)
const serializeTemplate = (
  template: Pick<TemplateDoc, "id" | "title" | "elementCount" | "preview" | "createdAt">,
): Api.TemplateSummary => ({
  id: template.id,
  title: template.title,
  elementCount: template.elementCount!,
  preview: template.preview,
  createdAt: template.createdAt,
});

async function fillMissingPreviews(templates: TemplateDoc[]) {
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

export async function listTemplates(req: Request, res: Response) {
  const templates = await Template.find({ owner: req.userId })
    .sort({ createdAt: -1 })
    .select("title createdAt elementCount preview");
  await fillMissingPreviews(templates);
  res.json({ templates: templates.map(serializeTemplate) } satisfies Api.TemplateListReply);
}

type Connecting = Element & ConnectorFields;

// images go with their board, so a template (which outlives it) can't carry them; lines and arrows attached to one are
// let go of it
function withoutImages(elements: Element[]): Element[] {
  const images = new Set<string | undefined>(
    elements.filter((element) => element.type === "image").map((element) => element.id),
  );
  return elements
    .filter((element) => element.type !== "image")
    .map((element) => {
      const attached = (["start", "end"] as const).filter((end) => images.has((element as Connecting)[`${end}Id`]));
      if (attached.length === 0) return element;
      const released = { ...element } as Connecting;
      for (const end of attached) {
        delete released[`${end}Id`];
        delete released[`${end}Anchor`];
      }
      return released;
    });
}

export async function createTemplate(
  req: Request<{}, unknown, { boardId?: unknown; title?: unknown } | undefined>,
  res: Response,
) {
  const board = await findBoardForMember(String(req.body?.boardId ?? ""), req.userId);
  const given = req.body?.title ?? "";
  if (typeof given !== "string") throw new HttpError(400, "The name must be text.");
  const title = given.trim() || board.title.slice(0, 60);
  if (title.length > 60) throw new HttpError(400, "Use 60 characters or fewer for the name.");

  const everything = await currentElements(board.id);
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

  // counts towards its owner's space; checks and writes run one at a time per person (see withRoom), so two saves sent
  // together can't both pass
  const template = await withRoom(req.userId!, { bytes }, async () => {
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
  res.status(201).json({ template: serializeTemplate(template) } satisfies Api.TemplateReply);
}

export async function deleteTemplate(req: Request<{ templateId: string }>, res: Response) {
  const { templateId } = req.params;
  const result = mongoose.isValidObjectId(templateId)
    ? await Template.deleteOne({ _id: templateId, owner: req.userId })
    : { deletedCount: 0 };
  if (result.deletedCount === 0) throw new HttpError(404, "That template doesn't exist anymore.");
  res.status(204).end();
}
