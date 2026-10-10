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

// Where opening a board has got to (see useBoardSync, which is still JavaScript and so doesn't say).
type BoardPhase = { name: string; status?: number; message?: string; wasViewer?: boolean };

// What this page reads of a board's details.
type BoardMeta = { title: string };

type OpenBoardProps = { boardId: string | undefined };

const backToBoards = <ButtonLink to="/boards">Go to your boards</ButtonLink>;
const goHome = <ButtonLink to="/">Go home</ButtonLink>;

export default function BoardPage() {
  const { boardId } = useParams<{ boardId: string }>();
  // Going from one board to another (a notification's Open button, back and forward)
  // keeps this page mounted. Keyed, each board gets its own editor and sync state, so
  // edits not sent yet can't end up on the other board, nor can its title, role or view.
  return <OpenBoard key={boardId} boardId={boardId} />;
}

function OpenBoard({ boardId }: OpenBoardProps) {
  const location = useLocation();
  const { user } = useAuth(); // null for guests viewing a shared link
  const exit = user ? backToBoards : goHome;
  const store = useMemo(createEditorStore, []);
  const sync = useBoardSync(boardId, store);

  useEffect(() => {
    // useBoardSync starts its meta as null, so its type is never inside this check.
    document.title = sync.meta ? `${(sync.meta as BoardMeta).title} · ${APP_NAME}` : APP_NAME;
    return () => {
      document.title = APP_NAME;
    };
  }, [sync.meta]);

  const { phase }: { phase: BoardPhase } = sync;

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
      // The server answers a guest with 401, so a 403 is only seen by someone logged in.
      return (
        <FullPageMessage icon={Lock} title="You don't have access to this board" action={backToBoards}>
          Ask the owner to invite <strong className="font-medium text-ink">{user!.email}</strong>, then open the link
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
