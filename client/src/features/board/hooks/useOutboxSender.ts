import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { toast } from "sonner";
import type { Role } from "../../../lib/api";
import type { AppSocket } from "../../../providers/SocketProvider";
import { ACK_TIMEOUT_MS } from "../constants/sync";
import type { createOutbox, Piece, SettleResult } from "../lib/sync/outbox";
import type { BoardStore } from "../lib/sync/store";
import type { createSuggester } from "../lib/sync/suggesting";
import type { OpReply } from "./useBoardSync";

const SLOW_TOAST = { id: "saving-slow" }; // one message however often it's said

// What to tell the person when the server refuses a change for good (see outbox.ts).
const REFUSED: Record<string, string> = {
  tooLarge:
    "That change was too big to save, so it was undone. The board may be full: delete something or start a new board.",
  forbidden: "You can only view this board now, so your last change wasn't saved.",
  ownerFull:
    "This board's owner has used up their space, so that change was undone. Delete something or empty the trash to make room.",
  invalid: "That change couldn't be saved, so it was undone.",
  outside: "That change was outside your frame, so it was undone.",
};

export const OUTSIDE_FRAME = "In classroom mode you can change only what's inside your frame, so that was put back.";

interface OutboxSenderOptions {
  socket: AppSocket | null;
  boardId: string;
  store: BoardStore;
  outbox: ReturnType<typeof createOutbox>;
  suggester: ReturnType<typeof createSuggester>;
  roleRef: RefObject<Role>;
  joined: RefObject<boolean>;
  flushTimer: RefObject<ReturnType<typeof setTimeout> | null>;
  rejoin: RefObject<() => void>;
  resync: RefObject<() => void>;
}

// Sends local changes in order, and acts on what the server answers (see outbox.ts).
export function useOutboxSender({
  socket,
  boardId,
  store,
  outbox,
  suggester,
  roleRef,
  joined,
  flushTimer,
  rejoin,
  resync,
}: OutboxSenderOptions) {
  const onReply = useRef<(result: SettleResult) => void>(() => {}); // what to do with the server's answer to a change (set below)

  const send = useCallback(
    (piece: Piece) => {
      const payload = { boardId, op: piece.op, ...(piece.group ? { group: piece.group } : {}) };
      // The assertion: a piece is only sent once there is a socket (see flush, and the replies and cleanup that send).
      socket!
        .timeout(ACK_TIMEOUT_MS)
        .emit("board:op", payload, (error: Error | null, response: OpReply | undefined) => {
          onReply.current(outbox.settle(piece.seq, error, response));
        });
    },
    [socket, boardId, outbox],
  );

  const flush = useCallback(() => {
    // The cast, here and below: clearTimeout takes null as well as undefined, which its types don't say.
    clearTimeout(flushTimer.current as ReturnType<typeof setTimeout> | undefined);
    flushTimer.current = null;
    if (!socket || !joined.current) return;
    const piece = outbox.take();
    if (piece) send(piece);
  }, [socket, outbox, send, flushTimer, joined]);

  useLayoutEffect(() => {
    onReply.current = (result: SettleResult) => {
      if (result.kind === "ok") {
        if (result.cleaned.length > 0 || result.dropped.length > 0 || result.restored.length > 0) {
          store.reconcile({ ...result, typing: outbox.typing() });
        }
        // In classroom mode, what a student did outside their frame was left out (and put back here).
        if (result.outside) toast(OUTSIDE_FRAME, { id: OUTSIDE_FRAME });
        else if (result.dropped.length > 0) {
          const count = result.dropped.length;
          toast.error(
            `The board is full, so ${count === 1 ? "1 element" : `${count} elements`} couldn't be added. Delete something or start a new board.`,
          );
        }
        if (result.next) send(result.next);
        // A change in pieces is done: what was made meanwhile waited for it (see outbox.ts).
        else if (outbox.hasPending() && joined.current) flushTimer.current ??= setTimeout(flush, 0);
      } else if (result.kind === "retry" || result.kind === "rejoin") {
        // A reconnect meanwhile showed the board as the server has it, maybe without this change yet; merging again is
        // harmless.
        if (result.again.upsert.length > 0 || result.again.remove.length > 0) store.applyRemote(result.again);
        if (result.kind === "rejoin") {
          // The server has no record of us being on this board: join again, then send.
          joined.current = false;
          rejoin.current();
        } else if (joined.current) {
          flushTimer.current ??= setTimeout(flush, result.delay);
        }
        // The server keeps turning changes away: they stay queued, and are sent again as it allows.
        // The cast: only a retry has `slow` (a rejoin reads as undefined).
        if ((result as { slow?: boolean }).slow)
          toast("Saving is taking longer than usual. Your changes are kept and will go through.", SLOW_TOAST);
      } else if (result.kind === "resync") {
        // Retrying can't help: put this screen back to what everyone else has, so it doesn't keep a drawing that was
        // never saved.
        toast.error(REFUSED[result.reason] ?? REFUSED.invalid);
        resync.current();
      }
    };
  });

  useEffect(() => {
    store.setBroadcaster((op) => {
      if (roleRef.current === "suggester") {
        suggester.take(op);
        return;
      }
      outbox.add(op);
      flushTimer.current ??= setTimeout(flush, outbox.flushDelay());
    });
    return () => store.setBroadcaster(() => {});
  }, [store, outbox, flush, suggester, roleRef, flushTimer]);

  return { send, flush };
}
