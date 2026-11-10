import { createHash } from "node:crypto";
import { cutText } from "@inkboard/shared/element-rules";
import { env } from "../config/env.ts";
import { userForToken } from "../lib/tokens.ts";
import { GuestKey } from "../models/guest-key.model.ts";
import type { RealtimeSocket } from "./types.ts";

// Who a connection is: a signed-in account, or a guest with a name and a key-bound id.

const GUEST_ID = /^g_[a-z0-9]{6,32}$/i;

export function cleanGuestName(value: unknown) {
  const name = cutText(
    String(value ?? "")
      .trim()
      .replace(/\s+/g, " "),
    40,
  );
  return name || "Guest";
}

const GUEST_KEY = /^[a-z0-9_-]{16,128}$/i;

// Ids are shown to everyone, so without the key an id was first used with, taking someone's id would let a person act
// as them (in classroom mode, draw in their frame). No valid key (or an old browser) gets an id for this connection.
async function guestIdentity(socket: RealtimeSocket, id: unknown, key: unknown): Promise<string> {
  const fallback = `g_${socket.id.replace(/[^a-z0-9]/gi, "")}`;
  // strings first: a pattern coerces its input, so ["g_abcdef"] would pass
  if (typeof id !== "string" || !GUEST_ID.test(id) || typeof key !== "string" || !GUEST_KEY.test(key)) return fallback;
  const hash = createHash("sha256").update(key).digest("base64url");
  // the first key an id comes with is the one it keeps
  const kept = await GuestKey.findOneAndUpdate(
    { _id: id },
    { $setOnInsert: { hash }, $set: { seenAt: new Date() } },
    { upsert: true, new: true },
  ).lean();
  return kept.hash === hash ? id : fallback;
}

// No token is allowed: guests open boards whose link is shared, with a name, a random id and a key proving it's theirs.
export async function authenticate(socket: RealtimeSocket, next: (error?: Error) => void) {
  const { token, guest }: { token?: unknown; guest?: { id?: unknown; name?: unknown; key?: unknown } } =
    socket.handshake.auth ?? {};
  if (!token) {
    socket.data.user = null;
    try {
      socket.data.guest = { id: await guestIdentity(socket, guest?.id, guest?.key), name: cleanGuestName(guest?.name) };
    } catch {
      return next(new Error("Couldn't connect. Try again."));
    }
    return next();
  }
  try {
    // anything that isn't a token makes userForToken throw
    const { user } = await userForToken(token as string);
    socket.data.user = user.toPublic();
    next();
  } catch {
    next(new Error("unauthorized"));
  }
}

// as far as the proxies in front of this server say (see TRUST_PROXY)
export function addressOf(socket: RealtimeSocket) {
  const hops = String(socket.handshake.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  const { trustProxy } = env;
  if (trustProxy === true && hops.length > 0) return hops[0];
  if (typeof trustProxy === "number" && trustProxy > 0 && hops.length >= trustProxy) {
    return hops[hops.length - trustProxy];
  }
  return socket.handshake.address;
}
