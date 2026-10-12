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

// Scripts can call much faster than people click, so the API is rationed per person.
const calling = limitPerUser({
  windowMs: 60 * 1000,
  limit: 120,
  message: "Too many API calls. Wait a minute and try again.",
});

// Mounted at /api/v1: the public API, for API tokens only (see docs/api.md).
export const publicApiRoutes = Router();
publicApiRoutes.use(requireApiToken, calling);
publicApiRoutes.get("/boards", listBoards);
publicApiRoutes.post("/boards", requireWriteScope, createBoard);
publicApiRoutes.get("/boards/:boardId", getBoard);
publicApiRoutes.post("/boards/:boardId/elements", requireWriteScope, writeElements);
publicApiRoutes.delete("/boards/:boardId/elements", requireWriteScope, removeElements);

// Mounted at /api/tokens: the person's API tokens, managed from Settings with their login.
export const tokenRoutes = Router();
tokenRoutes.use(requireAuth);
tokenRoutes.get("/", listTokens);
tokenRoutes.post("/", createToken);
tokenRoutes.delete("/:tokenId", deleteToken);

// Mounted at /mcp: the MCP server for AI assistants, with the same API tokens (see controllers/mcp.controller.ts).
export const mcpRoutes = Router();
mcpRoutes.post("/", requireApiToken, calling, handleMcp);
mcpRoutes.all("/", mcpMethodNotAllowed);
