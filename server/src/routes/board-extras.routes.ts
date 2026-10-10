import { Router } from "express";
import { listNotifications, markRead } from "../controllers/notification.controller.ts";
import { createTemplate, deleteTemplate, listTemplates } from "../controllers/template.controller.ts";
import {
  createThread,
  deleteThread,
  listThreads,
  replyToThread,
  updateThread,
} from "../controllers/thread.controller.ts";
import {
  deleteVersion,
  getVersion,
  listVersions,
  restoreVersion,
  saveVersion,
} from "../controllers/version.controller.ts";
import { requireAuth } from "../middleware/auth.ts";
import { limitPerUser } from "../middleware/user-limit.ts";

// Every comment can notify people, so they are rationed.
const commenting = limitPerUser({
  windowMs: 60 * 1000,
  limit: 40,
  message: "You're commenting very quickly. Wait a moment and try again.",
});

// Mounted at /api/boards/:boardId/versions
export const versionRoutes = Router({ mergeParams: true });
versionRoutes.use(requireAuth);
versionRoutes.get("/", listVersions);
versionRoutes.post("/", saveVersion);
versionRoutes.get("/:versionId", getVersion);
versionRoutes.post("/:versionId/restore", restoreVersion);
versionRoutes.delete("/:versionId", deleteVersion);

// Mounted at /api/boards/:boardId/threads
export const threadRoutes = Router({ mergeParams: true });
threadRoutes.use(requireAuth);
threadRoutes.get("/", listThreads);
threadRoutes.post("/", commenting, createThread);
threadRoutes.post("/:threadId/messages", commenting, replyToThread);
threadRoutes.patch("/:threadId", updateThread);
threadRoutes.delete("/:threadId", deleteThread);

// Mounted at /api/templates
export const templateRoutes = Router();
templateRoutes.use(requireAuth);
templateRoutes.get("/", listTemplates);
templateRoutes.post("/", createTemplate);
templateRoutes.delete("/:templateId", deleteTemplate);

// Mounted at /api/notifications
export const notificationRoutes = Router();
notificationRoutes.use(requireAuth);
notificationRoutes.get("/", listNotifications);
notificationRoutes.post("/read", markRead);
