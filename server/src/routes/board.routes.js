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
  listPreviews,
  listTrash,
  purgeBoard,
  removeCollaborator,
  renameBoard,
  restoreBoard,
  setLinkAccess,
  starBoard,
} from "../controllers/board.controller.js";
import { requireAuth } from "../middleware/auth.ts";
import { limitPerUser } from "../middleware/user-limit.ts";

const makingBoards = limitPerUser({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  message: "You're creating boards very quickly. Wait a few minutes and try again.",
});

// Each invite answers whether an account exists and sends a notification, so they are rationed.
const inviting = limitPerUser({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  message: "You've sent a lot of invites. Wait a few minutes and try again.",
});

const router = Router();

router.use(requireAuth);

router.get("/", listBoards);
router.post("/", makingBoards, createBoard);
// Fixed paths come before "/:boardId", which would take "trash" or "archive" as an id.
router.get("/trash", listTrash);
router.get("/previews", listPreviews);
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
router.post("/:boardId/collaborators", inviting, addCollaborator);
router.delete("/:boardId/collaborators/:userId", removeCollaborator);

export default router;
