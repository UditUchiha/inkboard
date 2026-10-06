import { Router } from "express";
import {
  addCollaborator,
  archiveBoards,
  createBoard,
  deleteBoard,
  emptyTrash,
  forgetBoard,
  getBoard,
  listBoards,
  listTrash,
  purgeBoard,
  removeCollaborator,
  renameBoard,
  restoreBoard,
  setLinkAccess,
  starBoard,
} from "../controllers/board.controller.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

router.get("/", listBoards);
router.post("/", createBoard);
// Fixed paths come before "/:boardId", which would take "trash" or "archive" as an id.
router.get("/trash", listTrash);
router.delete("/trash", emptyTrash);
router.patch("/archive", archiveBoards);
router.get("/:boardId", getBoard);
router.patch("/:boardId", renameBoard);
router.delete("/:boardId", deleteBoard);
router.patch("/:boardId/link-access", setLinkAccess);
router.put("/:boardId/star", starBoard);
router.post("/:boardId/restore", restoreBoard);
router.delete("/:boardId/permanent", purgeBoard);
router.delete("/:boardId/state", forgetBoard);
router.post("/:boardId/collaborators", addCollaborator);
router.delete("/:boardId/collaborators/:userId", removeCollaborator);

export default router;
