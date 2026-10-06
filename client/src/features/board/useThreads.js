import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";

const sortThreads = (list) => [...list].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

/**
 * A board's comment threads: loaded once, then kept current by the socket.
 * Comments are for signed-in people only (`enabled`), so guests never fetch them.
 */
export function useThreads({ boardId, socket, enabled }) {
  const [threads, setThreads] = useState([]);

  const upsert = useCallback((thread) => {
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

    const onDelete = ({ id }) => setThreads((list) => list.filter((item) => item.id !== id));
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
    create: async (input) => upsert((await api.createThread(boardId, input)).thread),
    reply: async (threadId, input) => upsert((await api.replyToThread(boardId, threadId, input)).thread),
    setResolved: async (threadId, resolved) => upsert((await api.updateThread(boardId, threadId, { resolved })).thread),
    remove: async (threadId) => {
      await api.deleteThread(boardId, threadId);
      setThreads((list) => list.filter((item) => item.id !== threadId));
    },
  };
}
