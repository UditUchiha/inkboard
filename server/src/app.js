import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { env } from "./config/env.ts";
import { errorHandler, notFound } from "./middleware/error-handler.ts";
import authRoutes from "./routes/auth.routes.js";
import { notificationRoutes, templateRoutes, threadRoutes, versionRoutes } from "./routes/board-extras.routes.js";
import boardRoutes from "./routes/board.routes.js";
import imageRoutes from "./routes/image.routes.js";

const defaultClientDist = fileURLToPath(new URL("../../client/dist", import.meta.url));

// Answers 200 while the process is up, even if the database is briefly unreachable: hosts such as
// Render restart an instance whose health check fails, and a restart doesn't fix a database blip.
// `database` and `status` still say what's wrong, for whoever is watching.
function health(req, res) {
  const database = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  res.set("Cache-Control", "no-store").json({
    status: database === "connected" ? "ok" : "degraded",
    database,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

// Profile photos from Google and GitHub, shown on avatars.
const PHOTO_HOSTS = ["https://*.googleusercontent.com", "https://avatars.githubusercontent.com"];

export function createApp({ clientDist = defaultClientDist } = {}) {
  const app = express();

  if (env.trustProxy) app.set("trust proxy", env.trustProxy);

  app.use(
    helmet({
      // The host terminates HTTPS; upgrading would break plain-HTTP local runs.
      // blob: lets a picture someone just added show straight away from their own copy.
      contentSecurityPolicy: {
        directives: { upgradeInsecureRequests: null, "img-src": ["'self'", "data:", "blob:", ...PHOTO_HOSTS] },
      },
    }),
  );
  // Board data and the app's scripts are text and shrink to a fraction of their size.
  app.use(compression());
  // Credentials: the app asks the API to set the cookie that ties a "connect Google/GitHub" link to its browser.
  app.use(cors({ origin: env.clientOrigins, credentials: true }));
  app.use(express.json({ limit: "2mb" }));

  // Used by Render's health check and the keep-alive cron. Registered before
  // the client fallback so /health returns JSON instead of the app's HTML.
  app.get(["/health", "/api/health"], health);
  app.use("/api/auth", authRoutes);
  app.use("/api/boards/:boardId/versions", versionRoutes);
  app.use("/api/boards/:boardId/threads", threadRoutes);
  app.use("/api/boards", boardRoutes);
  app.use("/api/images", imageRoutes);
  app.use("/api/templates", templateRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api", notFound);

  // In production the server also hosts the built client, so the whole app
  // runs as a single service on a single origin.
  if (existsSync(clientDist)) {
    app.use(
      express.static(clientDist, {
        index: false,
        setHeaders(res, filePath) {
          // Only the build's hashed files (client/dist/assets) never change; a parent folder named
          // "assets" somewhere in the absolute path doesn't make a file one of them.
          if (path.relative(clientDist, filePath).split(path.sep)[0] === "assets") {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      }),
    );
    app.use((req, res, next) => {
      if ((req.method !== "GET" && req.method !== "HEAD") || !req.accepts("html")) return next();
      // A missing file (a stale /assets/*.js, a font, robots.txt) is a 404, not the app's page.
      if (path.extname(req.path) || req.path.startsWith("/assets/")) return next();
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  app.use(errorHandler);
  return app;
}
