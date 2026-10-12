import mongoose from "mongoose";
import type { InferSchemaType } from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// What a token may do through the public API (see routes/api.routes.ts): read boards, or read and change them.
export const API_SCOPES = ["read", "write"] as const;

// A personal access token for the public API and the MCP server (see services/api-tokens.ts). Only a hash of the
// token is kept, and the start of it, so people can tell their tokens apart.
const apiTokenSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true, index: true },
    name: { type: String, trim: true, maxlength: 60, required: true },
    hash: { type: String, required: true, unique: true },
    start: { type: String, required: true },
    scope: { type: String, enum: API_SCOPES, required: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type ApiTokenFields = InferSchemaType<typeof apiTokenSchema>;

export const ApiToken = mongoose.model("ApiToken", apiTokenSchema);
