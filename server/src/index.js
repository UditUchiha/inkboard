import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "./app.js";
import { connectDatabase } from "./config/db.js";
import { env } from "./config/env.js";
import { attachRealtime, flushAllSessions } from "./realtime/index.js";
import { verifyAccountsMadeByProviders } from "./services/account-emails.js";
import { emailConfigured } from "./services/email.js";
import { startImageSweeper } from "./services/images.js";
import { startTrashSweeper } from "./services/trash.js";

const app = createApp();
const server = http.createServer(app);
const io = attachRealtime(server);

await connectDatabase();
await verifyAccountsMadeByProviders();
if (env.isProduction && !emailConfigured()) {
  console.warn(
    "Email isn't set up (BREVO_API_KEY, EMAIL_FROM): verification and password-reset emails won't be sent, " +
      "so new accounts can't verify their address or be invited to boards.",
  );
}
startTrashSweeper();
startImageSweeper();

server.listen(env.port, () => {
  console.log(`API ready on http://localhost:${env.port}`);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Saving open boards and shutting down.`);
  io.close();
  await flushAllSessions();
  await mongoose.disconnect();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
