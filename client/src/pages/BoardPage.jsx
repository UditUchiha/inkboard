import { FileQuestion, Lock, Trash2, UserX } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useParams } from "react-router";
import { ButtonLink } from "../components/Button";
import { FullPageLoader, FullPageMessage } from "../components/RouteGuards";
import { APP_NAME } from "../config";
import { BoardEditor } from "../features/board/BoardEditor";
import { createBoardStore } from "../features/board/store";
import { useBoardSync } from "../features/board/useBoardSync";
import { useAuth } from "../providers/AuthProvider";

const backToBoards = <ButtonLink to="/boards">Go to your boards</ButtonLink>;

export default function BoardPage() {
  const { boardId } = useParams();
  const { user } = useAuth();
  const store = useMemo(() => createBoardStore(), [boardId]);
  const sync = useBoardSync(boardId, store);

  useEffect(() => {
    document.title = sync.meta ? `${sync.meta.title} · ${APP_NAME}` : APP_NAME;
    return () => {
      document.title = APP_NAME;
    };
  }, [sync.meta]);

  const { phase } = sync;

  if (phase.name === "error") {
    if (phase.status === 403) {
      return (
        <FullPageMessage icon={Lock} title="You don't have access to this board" action={backToBoards}>
          Ask the owner to invite <strong className="font-medium text-ink">{user.email}</strong>, then open the link
          again.
        </FullPageMessage>
      );
    }
    return (
      <FullPageMessage icon={FileQuestion} title="This board doesn't exist" action={backToBoards}>
        {phase.message ?? "It may have been deleted by its owner."}
      </FullPageMessage>
    );
  }

  if (phase.name === "deleted") {
    return (
      <FullPageMessage icon={Trash2} title="This board was deleted" action={backToBoards}>
        Its owner deleted it while you had it open.
      </FullPageMessage>
    );
  }

  if (phase.name === "revoked") {
    return (
      <FullPageMessage icon={UserX} title="You no longer have access" action={backToBoards}>
        The owner removed you from this board.
      </FullPageMessage>
    );
  }

  if (phase.name !== "ready" || !sync.meta) return <FullPageLoader label="Opening board" />;

  return <BoardEditor store={store} sync={sync} user={user} />;
}
