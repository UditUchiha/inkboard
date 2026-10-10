import mongoose from "mongoose";
import { env } from "./env.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function connectDatabase({ attempts = 20, delayMs = 3000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
      console.log(`MongoDB connected to ${mongoose.connection.host}`);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      // The driver rejects with Error objects, which is what lets this read `.message`.
      console.warn(
        `MongoDB unavailable (attempt ${attempt}/${attempts}): ${(error as Error).message}. Retrying in ${delayMs / 1000}s.`,
      );
      await wait(delayMs);
    }
  }
}
