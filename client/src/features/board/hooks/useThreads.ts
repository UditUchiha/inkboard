import type { ThreadRemoval } from "@inkboard/shared/socket";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api";
import type { Thread } from "../../../lib/api";
import type { AppSocket } from "../../../providers/SocketProvider";
import type { XY } from "../lib/elements/geometry";

export type NewMessage = { body: string; mentions: string[] };

const sortThreads = (list: Thread[]) =>
  [...list].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

type ThreadsOptions = { boardId: string; socket: AppSocket | null; enabled: boolean };

// Comments are for signed-in people only, so guests never fetch them.
export function useThreads({ boardId, socket, enabled }: ThreadsOptions) {
  const [threads, setThreads] = useState<Thread[]>([]);

  const upsert = useCallback((thread: Thread) => {
    setThreads((list) => sortThreads([...list.filter((item) => item.id !== thread.id), thread]));
  }, []);

  useEffect(() => {
    setThreads([]);
    if (!enabled) return undefined;
    let active = true;
    const load = () =>
      api
        .listThreads(boardId)
        .then(({ threads: list }) => active && setThreads(list))
        .catch(() => {}); // Pins just don't show; the board still works.
    load();

    const onDelete = ({ id }: ThreadRemoval) => setThreads((list) => list.filter((item) => item.id !== id));
    // Comments made while we were disconnected arrive with a reload.
    socket?.on("connect", load);
    socket?.on("thread:upsert", upsert);
    socket?.on("thread:delete", onDelete);
    return () => {
      active = false;
      socket?.off("connect", load);
      socket?.off("thread:upsert", upsert);
      socket?.off("thread:delete", onDelete);
    };
  }, [boardId, socket, enabled, upsert]);

  return {
    threads,
    create: async (input: NewMessage & XY) => upsert((await api.createThread(boardId, input)).thread),
    reply: async (threadId: string, input: NewMessage) =>
      upsert((await api.replyToThread(boardId, threadId, input)).thread),
    react: async (threadId: string, messageId: string, emoji: string, on: boolean) =>
      upsert((await api.reactToMessage(boardId, threadId, messageId, emoji, on)).thread),
    setResolved: async (threadId: string, resolved: boolean) =>
      upsert((await api.updateThread(boardId, threadId, { resolved })).thread),
    remove: async (threadId: string) => {
      await api.deleteThread(boardId, threadId);
      setThreads((list) => list.filter((item) => item.id !== threadId));
    },
  };
}

export type ThreadApi = Omit<ReturnType<typeof useThreads>, "threads">;
