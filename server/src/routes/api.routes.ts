import { Router } from "express";
import {
  createBoard,
  createToken,
  deleteToken,
  getBoard,
  listBoards,
  listTokens,
  removeElements,
  writeElements,
} from "../controllers/api.controller.ts";
import { handleMcp, mcpMethodNotAllowed } from "../controllers/mcp.controller.ts";
import { requireApiToken, requireWriteScope } from "../middleware/api-token.ts";
import { requireAuth } from "../middleware/auth.ts";
import { limitPerUser } from "../middleware/user-limit.ts";

const calling = limitPerUser({
  windowMs: 60 * 1000,
  limit: 120,
  message: "Too many API calls. Wait a minute and try again.",
});

export const publicApiRoutes = Router();
publicApiRoutes.use(requireApiToken, calling);
publicApiRoutes.get("/boards", listBoards);
publicApiRoutes.post("/boards", requireWriteScope, createBoard);
publicApiRoutes.get("/boards/:boardId", getBoard);
publicApiRoutes.post("/boards/:boardId/elements", requireWriteScope, writeElements);
publicApiRoutes.delete("/boards/:boardId/elements", requireWriteScope, removeElements);

export const tokenRoutes = Router();
tokenRoutes.use(requireAuth);
tokenRoutes.get("/", listTokens);
tokenRoutes.post("/", createToken);
tokenRoutes.delete("/:tokenId", deleteToken);

export const mcpRoutes = Router();
mcpRoutes.post("/", requireApiToken, calling, handleMcp);
mcpRoutes.all("/", mcpMethodNotAllowed);
