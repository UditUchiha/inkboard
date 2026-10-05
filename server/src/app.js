import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/error-handler.js";
import authRoutes from "./routes/auth.routes.js";
import boardRoutes from "./routes/board.routes.js";

const clientDist = fileURLToPath(new URL("../../client/dist", import.meta.url));

function health(req, res) {
  const database = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  res
    .status(database === "connected" ? 200 : 503)
    .set("Cache-Control", "no-store")
    .json({
      status: database === "connected" ? "ok" : "degraded",
      database,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
}

export function createApp() {
  const app = express();

  if (env.isProduction) app.set("trust proxy", 1);

  app.use(
    helmet({
      // The host terminates HTTPS; upgrading would break plain-HTTP local runs.
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  );
  app.use(cors({ origin: env.clientOrigins }));
  app.use(express.json({ limit: "2mb" }));

  // Used by Render's health check and the keep-alive cron. Registered before
  // the client fallback so /health returns JSON instead of the app's HTML.
  app.get(["/health", "/api/health"], health);
  app.use("/api/auth", authRoutes);
  app.use("/api/boards", boardRoutes);
  app.use("/api", notFound);

  // In production the server also hosts the built client, so the whole app
  // runs as a single service on a single origin.
  if (existsSync(clientDist)) {
    app.use(
      express.static(clientDist, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.method !== "GET" || !req.accepts("html")) return next();
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  app.use(errorHandler);
  return app;
}
