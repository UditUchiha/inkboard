import { Router } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import {
  addCollaborator,
  archiveBoards,
  copyBoard,
  createBoard,
  deleteBoard,
  emptyTrash,
  forgetBoard,
  getBoard,
  imageUsage,
  listBoards,
  listPreviews,
  listTrash,
  purgeBoard,
  removeCollaborator,
  renameBoard,
  requestAccess,
  restoreBoard,
  setLinkAccess,
  starBoard,
  unlockBoard,
} from "../controllers/board.controller.ts";
import { optionalAuth, requireAuth } from "../middleware/auth.ts";
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

// Each request notifies a board's owner, so they are rationed.
const askingForAccess = limitPerUser({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  message: "You've asked for access a lot. Wait a few minutes and try again.",
});

// Guessing at a link's password: a few wrong tries per network address and board, then a wait.
const guessingPasswords = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  // A request that is being handled has an address (it's only missing once the connection has closed).
  keyGenerator: (req) => `${ipKeyGenerator(req.ip!)}:${String(req.params.boardId).toLowerCase()}`,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many wrong passwords. Wait a few minutes and try again." },
});

const router = Router();

// Giving a link's password is for guests too, so it comes before the routes that need a login.
router.post("/:boardId/unlock", guessingPasswords, optionalAuth, unlockBoard);

router.use(requireAuth);

router.get("/", listBoards);
router.post("/", makingBoards, createBoard);
// Fixed paths come before "/:boardId", which would take "trash" or "archive" as an id.
router.get("/trash", listTrash);
router.get("/previews", listPreviews);
router.get("/image-usage", imageUsage);
router.delete("/trash", emptyTrash);
router.patch("/archive", archiveBoards);
router.get("/:boardId", getBoard);
router.patch("/:boardId", renameBoard);
router.delete("/:boardId", deleteBoard);
router.patch("/:boardId/link-access", setLinkAccess);
router.put("/:boardId/star", starBoard);
router.post("/:boardId/copy", makingBoards, copyBoard);
router.post("/:boardId/restore", restoreBoard);
router.delete("/:boardId/permanent", purgeBoard);
router.delete("/:boardId/state", forgetBoard);
router.post("/:boardId/collaborators", inviting, addCollaborator);
router.post("/:boardId/access-requests", askingForAccess, requestAccess);
router.delete("/:boardId/collaborators/:userId", removeCollaborator);

export default router;
