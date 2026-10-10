import { FileQuestion, Lock, Trash2, UserX } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useLocation, useParams } from "react-router";
import { ButtonLink } from "../components/Button";
import { FullPageLoader, FullPageMessage } from "../components/RouteGuards";
import { APP_NAME } from "../config";
import { BoardEditor } from "../features/board/BoardEditor";
import { createEditorStore } from "../features/board/editorStore";
import { useBoardSync } from "../features/board/useBoardSync";
import { useAuth } from "../providers/AuthProvider";

const backToBoards = <ButtonLink to="/boards">Go to your boards</ButtonLink>;
const goHome = <ButtonLink to="/">Go home</ButtonLink>;

export default function BoardPage() {
  const { boardId } = useParams();
  // Going from one board to another (a notification's Open button, back and forward)
  // keeps this page mounted. Keyed, each board gets its own editor and sync state, so
  // edits not sent yet can't end up on the other board, nor can its title, role or view.
  return <OpenBoard key={boardId} boardId={boardId} />;
}

function OpenBoard({ boardId }) {
  const location = useLocation();
  const { user } = useAuth(); // null for guests viewing a shared link
  const exit = user ? backToBoards : goHome;
  const store = useMemo(createEditorStore, []);
  const sync = useBoardSync(boardId, store);

  useEffect(() => {
    document.title = sync.meta ? `${sync.meta.title} · ${APP_NAME}` : APP_NAME;
    return () => {
      document.title = APP_NAME;
    };
  }, [sync.meta]);

  const { phase } = sync;

  if (phase.name === "error") {
    if (phase.status === 401) {
      const next = encodeURIComponent(location.pathname + location.search);
      return (
        <FullPageMessage
          icon={Lock}
          title="This board is private"
          action={<ButtonLink to={`/login?next=${next}`}>Log in</ButtonLink>}
        >
          Log in to open it. You'll need to be invited by its owner.
        </FullPageMessage>
      );
    }
    if (phase.status === 403) {
      return (
        <FullPageMessage icon={Lock} title="You don't have access to this board" action={backToBoards}>
          Ask the owner to invite <strong className="font-medium text-ink">{user.email}</strong>, then open the link
          again.
        </FullPageMessage>
      );
    }
    return (
      <FullPageMessage icon={FileQuestion} title="This board doesn't exist" action={exit}>
        {phase.message ?? "It may have been deleted by its owner."}
      </FullPageMessage>
    );
  }

  if (phase.name === "deleted") {
    return (
      <FullPageMessage icon={Trash2} title="This board was deleted" action={exit}>
        Its owner deleted it while you had it open.
      </FullPageMessage>
    );
  }

  if (phase.name === "revoked") {
    return (
      <FullPageMessage icon={UserX} title="You no longer have access" action={exit}>
        {phase.wasViewer ? "The owner stopped sharing this board." : "The owner removed you from this board."}
      </FullPageMessage>
    );
  }

  if (phase.name !== "ready" || !sync.meta) return <FullPageLoader label="Opening board" />;

  return <BoardEditor store={store} sync={sync} user={user} />;
}
