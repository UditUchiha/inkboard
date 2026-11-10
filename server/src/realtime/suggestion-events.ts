import { cleanElement } from "@inkboard/shared/element-rules";
import type { SuggestionRefusal } from "@inkboard/shared/socket";
import { insideZone } from "@inkboard/shared/zones";
import type { FrameElement } from "@inkboard/shared/types";
import { isMemberRole } from "../services/boards.ts";
import { notifySuggestion } from "../services/notifications.ts";
import { getSession, markSuggestionsDirty } from "./sessions.ts";
import type { Session } from "./sessions.ts";
import { putSuggestions, resolveSuggestions, withdrawSuggestions } from "./suggestions.ts";
import type { RealtimeSocket, SocketLimits } from "./types.ts";
import { io, personOf, isOnBoard, socketsIn } from "./hub.ts";
import { zoneIn, showsSuggestion } from "./modes.ts";

// The suggestion events (see suggestions.ts for the rules), and telling a board what settled.

// a suggestion as sent, unchecked (see readDraft in suggestions.ts)
type RawDraft = { kind?: unknown; target?: unknown; element?: { id?: unknown } } | null | undefined;

function draftInside(draft: RawDraft, zone: FrameElement | null, session: Session) {
  if (!zone) return false;
  const current = (id: unknown) => (typeof id === "string" ? session.index.get(id) : undefined);
  if (draft?.kind === "remove") {
    const target = current(draft.target);
    return Boolean(target && insideZone(target, zone));
  }
  const element = cleanElement(draft?.element);
  if (!element || !insideZone(element, zone)) return false;
  const before = current(element.id);
  return draft?.kind === "add" ? !before : Boolean(before && insideZone(before, zone));
}

export function announceSettled(session: Session, { accepted, gone }: { accepted: string[]; gone: string[] }) {
  const { boardId } = session;
  if (accepted.length > 0) io.to(boardId).emit("suggestion:delete", { boardId, ids: accepted, outcome: "accepted" });
  if (gone.length > 0) io.to(boardId).emit("suggestion:delete", { boardId, ids: gone, outcome: "gone" });
  if (accepted.length + gone.length > 0) markSuggestionsDirty(session);
}

// when an open board's owner was last notified of suggestions
const suggestionsNoted = new WeakMap<Session, number>();
const SUGGESTION_NOTICE_MS = 60_000;

const SUGGESTION_FORBIDDEN = { ok: false, reason: "forbidden" } as const;
const SUGGESTION_INVALID = { ok: false, reason: "invalid" } as const;

export function registerSuggestions(socket: RealtimeSocket, limits: SocketLimits) {
  // Suggestions (see suggestions.ts, docs/suggest-mode.md): only a suggester makes them, anyone withdraws their own, a
  // member resolves them. Each counts against the same limit as a board change. Returns the session, or null after
  // replying.
  const suggestionSession = (
    payload: { boardId?: unknown } | null | undefined,
    reply: (refusal: SuggestionRefusal) => void,
  ): Session | null => {
    let refusal: SuggestionRefusal["reason"] | null = null;
    const session = isOnBoard(socket, payload?.boardId) ? getSession(socket.data.boardId!) : null;
    if (!limits.op()) refusal = "rate";
    else if (!session) refusal = "noSession";
    if (refusal) reply({ ok: false, reason: refusal });
    return refusal ? null : session!;
  };

  socket.on("suggestion:put", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const session = suggestionSession(payload, reply);
    if (!session) return;
    if (socket.data.role !== "suggester") return reply(SUGGESTION_FORBIDDEN);
    const sent = payload!.suggestions;
    if (!Array.isArray(sent)) return reply(SUGGESTION_INVALID);
    const { boardId } = session;
    // classroom mode: suggestions outside a student's frame are left out, as their changes are
    const zone = zoneIn(session, personOf(socket).userId, socket.data.boardRole);
    const outside: string[] = [];
    const drafts =
      zone === undefined
        ? sent
        : (sent as RawDraft[]).filter((draft) => {
            if (draftInside(draft, zone, session)) return true;
            const id = draft?.kind === "remove" ? draft.target : draft?.element?.id;
            if (typeof id === "string") outside.push(id);
            return false;
          });
    const result = putSuggestions(session.suggestions, session, personOf(socket), drafts);
    result.dropped.push(...outside);
    if (result.stored.length > 0) {
      for (const other of socketsIn(boardId)) {
        // in private mode, only to the author's other screens
        if (other !== socket && showsSuggestion(session, other)(result.stored[0])) {
          other.emit("suggestion:upsert", { boardId, suggestions: result.stored });
        }
      }
    }
    if (result.withdrawn.length > 0) {
      socket.to(boardId).emit("suggestion:delete", { boardId, ids: result.withdrawn, outcome: "withdrawn" });
    }
    if (result.stored.length + result.withdrawn.length > 0) markSuggestionsDirty(session);
    // a new suggestion (not a changed one) notifies the owner, at most once a minute per open board
    const made = result.stored.some((suggestion) => suggestion.createdAt === suggestion.updatedAt);
    if (made && !session.privateMode && Date.now() - (suggestionsNoted.get(session) ?? 0) > SUGGESTION_NOTICE_MS) {
      suggestionsNoted.set(session, Date.now());
      notifySuggestion(boardId, personOf(socket)).catch((error: unknown) => console.error(error));
    }
    reply({
      ok: true,
      suggestions: result.stored,
      ...(result.withdrawn.length > 0 ? { withdrawn: result.withdrawn } : {}),
      ...(result.dropped.length > 0 ? { dropped: result.dropped } : {}),
      ...(result.full ? { full: result.full } : {}),
    });
  });

  socket.on("suggestion:withdraw", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const session = suggestionSession(payload, reply);
    if (!session) return;
    const { boardId } = session;
    const ids = withdrawSuggestions(session.suggestions, personOf(socket), payload!.ids);
    if (ids.length > 0) {
      socket.to(boardId).emit("suggestion:delete", { boardId, ids, outcome: "withdrawn" });
      markSuggestionsDirty(session);
    }
    reply({ ok: true });
  });

  socket.on("suggestion:resolve", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const session = suggestionSession(payload, reply);
    if (!session) return;
    if (!isMemberRole(socket.data.role)) return reply(SUGGESTION_FORBIDDEN);
    const outcome = payload!.outcome;
    if (outcome !== "accepted" && outcome !== "rejected") return reply(SUGGESTION_INVALID);
    const { boardId } = session;
    const ids = resolveSuggestions(session.suggestions, payload!.ids);
    if (ids.length > 0) {
      socket.to(boardId).emit("suggestion:delete", { boardId, ids, outcome });
      markSuggestionsDirty(session);
    }
    reply({ ok: true });
  });
}
