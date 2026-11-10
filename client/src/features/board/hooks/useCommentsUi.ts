import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { BoardMeta } from "../../../lib/api";
import type { Size, Viewport, XY } from "../lib/elements/geometry";
import type { BoardSync } from "./useBoardSync";
import { useThreads } from "./useThreads";

interface CommentsUiOptions {
  sync: BoardSync;
  board: BoardMeta;
  selfId: string;
  enabled: boolean;
  canvasSize: Size;
  setViewport: (update: (vp: Viewport) => Viewport) => void;
}

export function useCommentsUi({ sync, board, selfId, enabled, canvasSize, setViewport }: CommentsUiOptions) {
  const location = useLocation();
  const [showComments, setShowComments] = useState(true);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [draft, setDraft] = useState<XY | null>(null); // where a new comment is being written
  const { threads, ...threadApi } = useThreads({ boardId: board.id, socket: sync.socket, enabled });
  const members = useMemo(
    () => [board.owner, ...board.collaborators].filter((person) => person && person.id !== selfId),
    [board.owner, board.collaborators, selfId],
  );

  // A notification links to ?thread=…: open that comment and bring it into view, once.
  const openedThread = useRef<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("thread");
    const thread = id && threads.find((item) => item.id === id);
    if (!thread || openedThread.current === id || !canvasSize.width) return;
    openedThread.current = id;
    setShowComments(true);
    setActiveThread(id);
    setViewport((vp) => ({
      ...vp,
      x: canvasSize.width / 2 / vp.zoom - thread.x,
      y: canvasSize.height / 2 / vp.zoom - thread.y,
    }));
  }, [threads, location.search, canvasSize, setViewport]);

  const placeComment = useCallback((point: XY) => {
    setActiveThread(null);
    setDraft(point);
  }, []);

  return {
    threads,
    threadApi,
    members,
    showComments,
    setShowComments,
    activeThread,
    setActiveThread,
    draft,
    setDraft,
    placeComment,
  };
}

export type CommentsUi = ReturnType<typeof useCommentsUi>;
