import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { changePassword, login, me, register, updateProfile } from "../controllers/auth.controller.js";
import {
  createLinkTicket,
  disconnectProvider,
  finishOAuth,
  listProviders,
  startOAuth,
} from "../controllers/oauth.controller.js";
import { requireAuth } from "../middleware/auth.js";

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many attempts. Wait a few minutes and try again." },
});

const router = Router();

router.post("/register", authLimiter, register);
router.post("/login", authLimiter, login);
router.get("/me", requireAuth, me);
router.patch("/me", requireAuth, updateProfile);
router.post("/password", authLimiter, requireAuth, changePassword);

router.get("/providers", listProviders);
router.get("/oauth/:provider", authLimiter, startOAuth);
router.get("/oauth/:provider/callback", finishOAuth);
router.post("/oauth/:provider/link", requireAuth, createLinkTicket);
router.delete("/oauth/:provider", requireAuth, disconnectProvider);

export default router;
