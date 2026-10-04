import { Router } from "express";
import {
  addCollaborator,
  createBoard,
  deleteBoard,
  getBoard,
  listBoards,
  removeCollaborator,
  renameBoard,
} from "../controllers/board.controller.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

router.get("/", listBoards);
router.post("/", createBoard);
router.get("/:boardId", getBoard);
router.patch("/:boardId", renameBoard);
router.delete("/:boardId", deleteBoard);
router.post("/:boardId/collaborators", addCollaborator);
router.delete("/:boardId/collaborators/:userId", removeCollaborator);

export default router;
