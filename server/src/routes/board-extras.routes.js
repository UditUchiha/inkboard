import { Router } from "express";
import { listNotifications, markRead } from "../controllers/notification.controller.js";
import { createTemplate, deleteTemplate, listTemplates } from "../controllers/template.controller.js";
import {
  createThread,
  deleteThread,
  listThreads,
  replyToThread,
  updateThread,
} from "../controllers/thread.controller.js";
import { deleteVersion, getVersion, listVersions, restoreVersion, saveVersion } from "../controllers/version.controller.js";
import { requireAuth } from "../middleware/auth.js";

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
threadRoutes.post("/", createThread);
threadRoutes.post("/:threadId/messages", replyToThread);
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
