import type {
  ClassroomPayload,
  CountdownPayload,
  ReplayReply,
  SuggestionOutcome,
  SuggestionPutReply,
  VotePayload,
} from "@inkboard/shared/socket";
import type { SuggestionDraft } from "@inkboard/shared/suggestions";
import { useCallback, useLayoutEffect } from "react";
import type { RefObject } from "react";
import { toast } from "sonner";
import { api } from "../../../lib/api";
import { savePass } from "../../../lib/linkPasses";
import type { AppSocket } from "../../../providers/SocketProvider";
import type { createSuggester } from "../lib/sync/suggesting";
import type { createSuggestionStore } from "../lib/sync/suggestions";
import type { Phase } from "./useBoardSync";

import { ACK_TIMEOUT_MS } from "../constants/sync";

// How the suggester sends and whose suggestions are ours: it is made once, so effects keep these current.
export interface LiveSuggesting {
  selfId: string;
  isSelf: (userId: string) => boolean;
  send: (drafts: SuggestionDraft[], withdraw: string[]) => Promise<SuggestionPutReply>;
}

interface SessionCommandsOptions {
  socket: AppSocket | null;
  boardId: string;
  joined: RefObject<boolean>;
  presenting: RefObject<boolean>;
  rejoin: RefObject<() => void>;
  suggestions: ReturnType<typeof createSuggestionStore>;
  suggester: ReturnType<typeof createSuggester>;
  live: LiveSuggesting;
  setPhase: (phase: Phase) => void;
}

// What this screen asks of the session: the replay, timer, private mode, classroom, votes, suggestions and the link password.
export function useSessionCommands({
  socket,
  boardId,
  joined,
  presenting,
  rejoin,
  suggestions,
  suggester,
  live,
  setPhase,
}: SessionCommandsOptions) {
  useLayoutEffect(() => {
    live.send = (drafts, withdraw) =>
      new Promise((resolve) => {
        if (!socket || !joined.current) return resolve({ ok: false, reason: "noSession" });
        if (withdraw.length > 0) socket.emit("suggestion:withdraw", { boardId, ids: withdraw }, () => {});
        if (drafts.length === 0) return resolve({ ok: true, suggestions: [] });
        socket
          .timeout(ACK_TIMEOUT_MS)
          .emit("suggestion:put", { boardId, suggestions: drafts }, (error: Error | null, reply?: SuggestionPutReply) =>
            resolve(error || !reply ? { ok: false, reason: "noSession" } : reply),
          );
      });
  });

  // For members and, when the owner lets them, link visitors.
  const loadReplay = useCallback(
    (): Promise<ReplayReply> =>
      new Promise((resolve) => {
        if (!socket || !joined.current) resolve({ ok: false, error: "You're offline. Try again once you're back." });
        else socket.emit("board:replay", { boardId }, resolve);
      }),
    [socket, boardId, joined],
  );

  // Others are shown who presents and follow them (see useFollow); remembered so a reconnect joins as the presenter again.
  const present = useCallback(
    (on: boolean) => {
      presenting.current = on;
      if (joined.current) socket?.emit("present", { on });
    },
    [socket, joined, presenting],
  );

  const controlTimer = useCallback(
    (payload: CountdownPayload) => {
      socket?.emit("countdown", payload);
    },
    [socket],
  );

  const setPrivate = useCallback(
    (on: boolean) => {
      socket?.emit("private", { on });
    },
    [socket],
  );

  // Resolves with whether it was done.
  const changeClassroom = useCallback(
    (payload: ClassroomPayload) =>
      new Promise<boolean>((resolve) => {
        if (!socket?.connected) return resolve(false);
        socket
          .timeout(10_000)
          .emit("classroom", payload, (error: Error | null, reply?: { ok: boolean }) =>
            resolve(!error && reply?.ok === true),
          );
      }),
    [socket],
  );

  // Decisions go from this screen at once; accepting is the member's own change to the board, made before (see suggestions.ts).
  const resolveSuggestions = useCallback(
    (ids: string[], outcome: SuggestionOutcome) => {
      if (ids.length === 0) return;
      suggestions.remove(ids);
      socket?.emit("suggestion:resolve", { boardId, ids, outcome }, (reply) => {
        if (!reply?.ok) toast.error("That decision couldn't be saved. Open the board again and try once more.");
      });
    },
    [socket, boardId, suggestions],
  );

  const vote = useCallback(
    (payload: VotePayload) => {
      socket?.emit("vote", payload);
    },
    [socket],
  );

  // Rejects with the server's reason (a wrong password, say), for the form to show.
  const unlock = useCallback(
    async (password: string) => {
      const { pass } = await api.unlockBoard(boardId, password);
      savePass(boardId, pass);
      setPhase({ name: "connecting" });
      rejoin.current();
    },
    [boardId, rejoin, setPhase],
  );

  const withdrawSuggestions = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      suggestions.remove(ids);
      socket?.emit("suggestion:withdraw", { boardId, ids }, () => {});
      suggester.rebuild();
    },
    [socket, boardId, suggestions, suggester],
  );

  return {
    loadReplay,
    present,
    controlTimer,
    setPrivate,
    changeClassroom,
    resolveSuggestions,
    vote,
    unlock,
    withdrawSuggestions,
  };
}
