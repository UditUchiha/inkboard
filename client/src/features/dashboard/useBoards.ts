import type { Element as BoardElement } from "@inkboard/shared/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { ApiError } from "../../lib/api";
import type { BoardSummary } from "./sections";

/** What the board list requests answer with. */
type BoardList = { boards: BoardSummary[] };

// Previews are asked for this many boards at a time (the server's limit).
const PREVIEW_BATCH = 24;

// A preview belongs to one version of a board: a board changed since it was asked for (a refresh landed while it
// was on its way) needs its own.
const previewKey = (board: BoardSummary) => `${board.id}@${board.updatedAt}`;

/**
 * `list` with the previews in `found` (preview key -> elements) put on the boards they were asked for. A board that
 * has changed since is left alone, so it shows nothing rather than how it used to look, and is asked for again.
 */
export function fillPreviews(list: BoardSummary[] | null | undefined, found: Map<string, BoardElement[]>) {
  return list?.map((board) =>
    found.has(previewKey(board)) ? { ...board, preview: found.get(previewKey(board)) } : board,
  );
}

/**
 * The dashboard's boards and the owner's trash, with local updates so actions feel instant.
 * The lists come without previews; `loadPreviews` fetches the ones for the cards on screen and
 * puts them on the boards as `preview`.
 */
export function useBoards() {
  // A change that lands while a list is still null leaves it undefined (list?.map), which only an update to a
  // board that isn't there could do.
  const [boards, setBoards] = useState<BoardSummary[] | null | undefined>(null);
  const [trash, setTrash] = useState<BoardSummary[] | undefined>([]);
  const [loadError, setLoadError] = useState("");
  // board id -> { updatedAt, preview }, so a refresh keeps what it already has
  const previews = useRef(new Map<string, { updatedAt: string; preview: BoardElement[] | undefined }>());
  const asked = useRef(new Set<string>()); // preview keys (board id and version) whose preview is on its way

  const withKnownPreview = (board: BoardSummary) => {
    const known = previews.current.get(board.id);
    return known && known.updatedAt === board.updatedAt ? { ...board, preview: known.preview } : board;
  };

  const refresh = useCallback(async () => {
    // Neither list request says what it answers with yet, so their answers are described here.
    const [{ boards: list }, { boards: trashed }] = (await Promise.all([api.listBoards(), api.listTrash()])) as [
      BoardList,
      BoardList,
    ];
    setBoards(list.map(withKnownPreview));
    setTrash(trashed.map(withKnownPreview));
  }, []);

  useEffect(() => {
    let active = true;
    refresh().catch((error: ApiError) => active && setLoadError(error.message));
    return () => {
      active = false;
    };
  }, [refresh]);

  const patch = useCallback(
    (ids: string[], changes: Partial<BoardSummary>) =>
      setBoards((list) => list?.map((board) => (ids.includes(board.id) ? { ...board, ...changes } : board))),
    [],
  );
  const drop = useCallback(
    (ids: string[]) => setBoards((list) => list?.filter((board) => !ids.includes(board.id))),
    [],
  );

  // Fetches the previews `wanted` boards (from either list) don't have yet, one batch at a time.
  const loadPreviews = useCallback(async (wanted: BoardSummary[]) => {
    const todo = wanted.filter((board) => !board.preview && !asked.current.has(previewKey(board)));
    for (const board of todo) asked.current.add(previewKey(board));
    for (let start = 0; start < todo.length; start += PREVIEW_BATCH) {
      const batch = todo.slice(start, start + PREVIEW_BATCH);
      try {
        // boardPreviews doesn't say what it answers with yet either.
        const { previews: found } = (await api.boardPreviews(batch.map((board) => board.id))) as {
          previews: Record<string, BoardElement[]>;
        };
        // A board the server sent nothing for (gone, or no longer open to this person) just draws as empty.
        const byKey = new Map(batch.map((board) => [previewKey(board), found[board.id] ?? []]));
        for (const board of batch) {
          // An answer that comes back late mustn't replace the preview of a newer version.
          const known = previews.current.get(board.id);
          if (known && new Date(known.updatedAt) > new Date(board.updatedAt)) continue;
          previews.current.set(board.id, { updatedAt: board.updatedAt, preview: byKey.get(previewKey(board)) });
        }
        setBoards((list) => fillPreviews(list, byKey));
        setTrash((list) => fillPreviews(list, byKey));
      } catch {
        // The cards stay blank; asking again (the next refresh) tries once more.
      } finally {
        for (const board of batch) asked.current.delete(previewKey(board));
      }
    }
  }, []);

  return { boards, trash, loadError, patch, drop, refresh, loadPreviews };
}
