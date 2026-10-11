// Runs a local MongoDB for development so no database install or cloud
// account is needed. Data is kept in server/.data between runs.
// Skipped when server/.env points MONGODB_URI at another database.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MongoMemoryServer } from "mongodb-memory-server";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // No .env file: use the defaults.
}

const PORT = Number(process.env.DEV_DB_PORT) || 27017;
const uri = process.env.MONGODB_URI;

if (uri && !uri.includes(`127.0.0.1:${PORT}`) && !uri.includes(`localhost:${PORT}`)) {
  console.log("MONGODB_URI is set in server/.env, so the local database isn't needed.");
  process.exit(0);
}

const dbPath = fileURLToPath(new URL("../.data/db", import.meta.url));
mkdirSync(dbPath, { recursive: true });

console.log("Starting local MongoDB (the first run downloads it, which can take a few minutes)...");

const mongo = await MongoMemoryServer.create({
  instance: { port: PORT, dbPath, storageEngine: "wiredTiger" },
});

console.log(`Local MongoDB ready at ${mongo.getUri()}`);

async function stop() {
  await mongo.stop({ doCleanup: false });
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
