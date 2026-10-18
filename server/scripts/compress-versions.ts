// Compresses the versions saved before versions were compressed, freeing most of their space (see
// packElements in services/versions.ts). The server reads both forms, so this is optional and can run
// while it's up; stopped part-way, it picks up where it left off. Run with: npm run compress-versions -w server
import mongoose from "mongoose";
import { env } from "../src/config/env.ts";
import { compressOldVersions } from "../src/services/versions.ts";

await mongoose.connect(env.mongoUri);
try {
  const compressed = await compressOldVersions((count) => {
    if (count % 50 === 0) console.log(`Compressed ${count} versions...`);
  });
  console.log(`Done: compressed ${compressed} versions.`);
} finally {
  await mongoose.disconnect();
}
