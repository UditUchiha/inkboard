import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";

/** The dashboard's boards and the owner's trash, with local updates so actions feel instant. */
export function useBoards() {
  const [boards, setBoards] = useState(null);
  const [trash, setTrash] = useState([]);
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async () => {
    const [{ boards: list }, { boards: trashed }] = await Promise.all([api.listBoards(), api.listTrash()]);
    setBoards(list);
    setTrash(trashed);
  }, []);

  useEffect(() => {
    let active = true;
    refresh().catch((error) => active && setLoadError(error.message));
    return () => {
      active = false;
    };
  }, [refresh]);

  const patch = useCallback(
    (ids, changes) =>
      setBoards((list) => list?.map((board) => (ids.includes(board.id) ? { ...board, ...changes } : board))),
    [],
  );
  const drop = useCallback((ids) => setBoards((list) => list?.filter((board) => !ids.includes(board.id))), []);

  return { boards, trash, loadError, patch, drop, refresh };
}
