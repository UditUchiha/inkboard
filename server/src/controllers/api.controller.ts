import type { Request, Response } from "express";
import { createApiToken, deleteApiToken, listApiTokens } from "../services/api-tokens.ts";
import * as publicApi from "../services/public-api.ts";

// The public API (see docs/api.md and routes/api.routes.ts). `requireApiToken` has set `userId` by the time these
// run, which the types can't know; the same goes for the token routes and `requireAuth`.

type BoardRequest = Request<{ boardId: string }>;

export async function listBoards(req: Request, res: Response) {
  res.json({ boards: await publicApi.listBoards(req.userId!) });
}

export async function createBoard(req: Request, res: Response) {
  res.status(201).json({ board: await publicApi.createBoard(req.userId!, req.body?.title) });
}

export async function getBoard(req: BoardRequest, res: Response) {
  res.json({ board: await publicApi.readBoard(req.userId!, req.params.boardId) });
}

export async function writeElements(req: BoardRequest, res: Response) {
  res.json(await publicApi.writeElements(req.userId!, req.params.boardId, req.body?.elements));
}

export async function removeElements(req: BoardRequest, res: Response) {
  res.json(await publicApi.removeElements(req.userId!, req.params.boardId, req.body?.ids));
}

// The person's own tokens, managed from Settings (with a login, not a token).

export async function listTokens(req: Request, res: Response) {
  res.json({ tokens: await listApiTokens(req.userId!) });
}

export async function createToken(req: Request, res: Response) {
  res.status(201).json(await createApiToken(req.userId!, req.body?.name, req.body?.scope));
}

export async function deleteToken(req: Request<{ tokenId: string }>, res: Response) {
  await deleteApiToken(req.userId!, req.params.tokenId);
  res.status(204).end();
}
