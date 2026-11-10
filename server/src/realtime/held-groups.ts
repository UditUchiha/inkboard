import { MAX_GROUP_BYTES } from "./operations.ts";
import type { ExpiredGroup, HeldGroup } from "./operations.ts";
import type { RealtimeSocket } from "./types.ts";

// Memory held for changes sent in pieces (see holdPiece), capped per sender and overall.

// Held pieces take memory until the group completes: idle groups are dropped, and bytes are capped per sender (an
// account, or a guest's address: guests can open many connections) and overall. Over a cap the sender gets "rate".
const GROUP_IDLE_MS = 60_000;
const MAX_HELD_BYTES_PER_SENDER = 2 * MAX_GROUP_BYTES;
const MAX_HELD_BYTES = 4 * MAX_GROUP_BYTES;
const held = { total: 0, bySender: new Map<string, number>() };

// Returns false, holding nothing, when keeping `group` would pass a cap.
export function holdGroup(socket: RealtimeSocket, group: HeldGroup | ExpiredGroup | null) {
  const { sender } = socket.data;
  const before = socket.data.heldGroup?.bytes ?? 0;
  const ofSender = held.bySender.get(sender) ?? 0;
  const growth = (group?.bytes ?? 0) - before;
  const fits = growth <= 0 || (held.total + growth <= MAX_HELD_BYTES && ofSender + growth <= MAX_HELD_BYTES_PER_SENDER);
  const kept = fits ? group : null;
  const change = (kept?.bytes ?? 0) - before;
  held.total += change;
  if (ofSender + change > 0) held.bySender.set(sender, ofSender + change);
  else held.bySender.delete(sender);
  socket.data.heldGroup = kept;
  clearTimeout(socket.data.heldTimer!); // clearTimeout accepts null/undefined, which Node's types omit
  socket.data.heldTimer = kept?.pieces ? setTimeout(() => expireGroup(socket), GROUP_IDLE_MS).unref() : null;
  return fits;
}

// the id is kept, so a late piece is told to resend rather than "invalid"
function expireGroup(socket: RealtimeSocket) {
  const { id } = socket.data.heldGroup ?? {};
  holdGroup(socket, id ? { id, expired: true } : null);
}

export const heldGroupBytes = () => held.total;
