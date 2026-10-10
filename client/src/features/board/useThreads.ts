import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { api } from "../../lib/api";
import type { Person } from "../../lib/api";
import type { XY } from "./geometry";

/** One comment in a thread. `mentions` are the people named in it. */
export type ThreadMessage = {
  id: string;
  author: Person;
  body: string;
  mentions: Person[];
  createdAt: string;
};

/** A comment thread as the server lists it (see serializeThread there): pinned at (x, y) on the board. */
export type Thread = XY & {
  id: string;
  resolved: boolean;
  author: Person;
  createdAt: string;
  messages: ThreadMessage[];
};

/** What someone writes: the text, and the ids of the people they mentioned in it. */
export type NewMessage = { body: string; mentions: string[] };

// What the thread requests answer with. They don't say yet, so these describe their answers.
type ThreadList = { threads: Thread[] };
type ThreadReply = { thread: Thread };

const sortThreads = (list: Thread[]) =>
  // @ts-expect-error Subtracting two Dates gives the milliseconds between them, which TypeScript only allows on numbers.
  [...list].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

/** What useThreads takes: the board, the connection that keeps threads current, and whether to have any. */
type ThreadsOptions = { boardId: string; socket: Socket | null; enabled: boolean };

/**
 * A board's comment threads: loaded once, then kept current by the socket.
 * Comments are for signed-in people only (`enabled`), so guests never fetch them.
 */
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
      (api.listThreads(boardId) as Promise<ThreadList>)
        .then(({ threads: list }) => active && setThreads(list))
        .catch(() => {}); // Pins just don't show; the board still works.
    load();

    const onDelete = ({ id }: { id: string }) => setThreads((list) => list.filter((item) => item.id !== id));
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
    create: async (input: NewMessage & XY) => upsert(((await api.createThread(boardId, input)) as ThreadReply).thread),
    reply: async (threadId: string, input: NewMessage) =>
      upsert(((await api.replyToThread(boardId, threadId, input)) as ThreadReply).thread),
    setResolved: async (threadId: string, resolved: boolean) =>
      upsert(((await api.updateThread(boardId, threadId, { resolved })) as ThreadReply).thread),
    remove: async (threadId: string) => {
      await api.deleteThread(boardId, threadId);
      setThreads((list) => list.filter((item) => item.id !== threadId));
    },
  };
}

/** What the editor does with threads: the list's actions, as the comments layer is given them. */
export type ThreadApi = Omit<ReturnType<typeof useThreads>, "threads">;
