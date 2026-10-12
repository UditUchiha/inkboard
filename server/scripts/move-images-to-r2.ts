// Moves the images kept in MongoDB (GridFS) to Cloudflare R2, once R2_* are set (see docs/image-storage.md).
// New uploads already go to R2 by then; this moves the ones from before, freeing their space in the database.
// It can be stopped and run again: it picks up where it left off. Run with: npm run move-images-to-r2 -w server
import mongoose from "mongoose";
import { env } from "../src/config/env.ts";
import { moveImagesToR2 } from "../src/services/image-storage.ts";

if (!env.r2) {
  console.error("R2 isn't set up: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET first.");
  process.exit(1);
}

await mongoose.connect(env.mongoUri);
try {
  const moved = await moveImagesToR2((count) => {
    if (count % 50 === 0) console.log(`Moved ${count} files...`);
  });
  console.log(`Done: moved ${moved} files (images and their small copies) to R2.`);
} finally {
  await mongoose.disconnect();
}
