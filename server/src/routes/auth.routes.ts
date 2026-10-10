import { Router } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import {
  changePassword,
  forgotPassword,
  login,
  logoutEverywhere,
  me,
  register,
  resendVerification,
  resetPassword,
  updateProfile,
  verifyEmail,
} from "../controllers/auth.controller.ts";
import {
  confirmLink,
  createLinkTicket,
  disconnectProvider,
  exchangeLoginCode,
  finishOAuth,
  listProviders,
  startOAuth,
} from "../controllers/oauth.controller.ts";
import { requireAuth, requireRecentLogin } from "../middleware/auth.ts";
import { limitPerUser } from "../middleware/user-limit.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const tooMany = { error: "Too many attempts. Wait a few minutes and try again." };

// Each kind of request has its own allowance, so that, say, a school where everyone signs in from one
// address doesn't use up the sign-ups of the next class. Limits count per address, and the ones that
// guess at or flood a particular account also count per email address (with the address too, for logins).
const perAddress = ({
  windowMs = 15 * MINUTE,
  limit,
  failedOnly = false,
}: {
  windowMs?: number;
  limit: number;
  failedOnly?: boolean;
}) =>
  rateLimit({
    windowMs,
    limit,
    skipSuccessfulRequests: failedOnly,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: tooMany,
  });

// `andAddress` counts each email per network address instead of across all of them.
const perEmail = ({
  windowMs = 15 * MINUTE,
  limit,
  failedOnly = false,
  andAddress = false,
}: {
  windowMs?: number;
  limit: number;
  failedOnly?: boolean;
  andAddress?: boolean;
}) =>
  rateLimit({
    windowMs,
    limit,
    skipSuccessfulRequests: failedOnly,
    keyGenerator: (req) => {
      // The body is whatever was sent, and is made a string here.
      const email = String((req.body as { email?: unknown } | undefined)?.email ?? "")
        .trim()
        .toLowerCase()
        .slice(0, 254);
      // A request that is being handled has an address (it's only missing once the connection has closed).
      if (!email) return ipKeyGenerator(req.ip!);
      return andAddress ? `email:${email}|${ipKeyGenerator(req.ip!)}` : `email:${email}`;
    },
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: tooMany,
  });

// Logins that worked don't count, so only wrong guesses use the allowance up. Guesses at one account
// count per network address, so whoever makes them only locks themselves out of it: a limit on the
// account alone would let anyone, from anywhere, keep its owner from logging in (M9). Guesses spread
// over many addresses are held back by each address's own allowance and the cost of every check.
const loginLimits = [
  perAddress({ limit: 30, failedOnly: true }),
  perEmail({ limit: 10, failedOnly: true, andAddress: true }),
];
const registerLimit = perAddress({ windowMs: HOUR, limit: 20 });
// Each reset request sends an email, which costs quota (see EMAIL_DAILY_LIMIT) and bothers whoever owns the address.
const forgotLimits = [perAddress({ limit: 20 }), perEmail({ windowMs: HOUR, limit: 3 })];
const linkLimit = perAddress({ limit: 30 });
const passwordLimit = limitPerUser({ windowMs: 15 * MINUTE, limit: 10, message: tooMany.error });
const resendLimit = limitPerUser({ windowMs: 15 * MINUTE, limit: 5, message: tooMany.error });
const logoutLimit = limitPerUser({ windowMs: 15 * MINUTE, limit: 10, message: tooMany.error });
const connectLimit = limitPerUser({ windowMs: 15 * MINUTE, limit: 10, message: tooMany.error });
const oauthStartLimit = perAddress({ limit: 60 });

const router = Router();

router.post("/register", registerLimit, register);
router.post("/login", ...loginLimits, login);
router.get("/me", requireAuth, me);
router.patch("/me", requireAuth, updateProfile);
router.post("/password", requireAuth, passwordLimit, changePassword);
router.post("/logout-everywhere", requireAuth, logoutLimit, logoutEverywhere);
router.post("/verify-email", requireAuth, linkLimit, verifyEmail);
router.post("/verify-email/resend", requireAuth, resendLimit, resendVerification);
router.post("/forgot-password", ...forgotLimits, forgotPassword);
router.post("/reset-password", linkLimit, resetPassword);

router.get("/providers", listProviders);
router.get("/oauth/:provider", oauthStartLimit, startOAuth);
router.get("/oauth/:provider/callback", finishOAuth);
router.post("/oauth/exchange", oauthStartLimit, exchangeLoginCode);
router.post("/oauth/:provider/link", requireAuth, requireRecentLogin, connectLimit, createLinkTicket);
router.post("/oauth/:provider/link/confirm", requireAuth, connectLimit, confirmLink);
router.delete("/oauth/:provider", requireAuth, disconnectProvider);

export default router;
