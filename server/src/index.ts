import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "./app.ts";
import { connectDatabase } from "./config/db.ts";
import { env } from "./config/env.ts";
import { attachRealtime, closeRealtime } from "./realtime/index.ts";
import { verifyAccountsMadeByProviders } from "./services/account-emails.ts";
import { emailConfigured } from "./services/email.ts";
import { startImageSweeper } from "./services/images.ts";
import { startTrashSweeper } from "./services/trash.ts";

const app = createApp();
const server = http.createServer(app);
attachRealtime(server);

await connectDatabase();
await verifyAccountsMadeByProviders();
if (!emailConfigured()) {
  console.log("Email isn't set up (BREVO_API_KEY, EMAIL_FROM), so email verification and password reset are off.");
}
startTrashSweeper();
startImageSweeper();

server.listen(env.port, () => {
  console.log(env.isProduction ? `API ready on port ${env.port}` : `API ready on http://localhost:${env.port}`);
});

// Render sends SIGTERM and stops the process after 30 seconds, so there's no use trying for longer.
const SHUTDOWN_DEADLINE_MS = 20_000;
let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${reason} received. Saving open boards and shutting down.`);
  setTimeout(() => {
    console.error("Shutting down took too long. Exiting without finishing.");
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
  try {
    await closeRealtime();
    await mongoose.disconnect();
  } catch (error) {
    // Anything can be thrown; closing the database and sockets throws Errors.
    console.error(`Shutting down failed: ${(error as Error).message}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// A crash still saves what people drew (when the process can still do that).
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  shutdown("unhandledRejection", 1);
});
