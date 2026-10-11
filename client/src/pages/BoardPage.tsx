import { FileQuestion, KeyRound, Lock, TimerOff, Trash2, UserX } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useLocation, useParams } from "react-router";
import { ButtonLink } from "../components/Button";
import { FullPageLoader, FullPageMessage } from "../components/RouteGuards";
import { APP_NAME } from "../config";
import { BoardEditor } from "../features/board/BoardEditor";
import { createEditorStore } from "../features/board/editorStore";
import { LinkPasswordForm } from "../features/board/LinkPasswordForm";
import { useBoardSync } from "../features/board/useBoardSync";
import { getGuest } from "../lib/guest";
import { useAuth } from "../providers/AuthProvider";

type OpenBoardProps = { boardId: string };

const backToBoards = <ButtonLink to="/boards">Go to your boards</ButtonLink>;
const goHome = <ButtonLink to="/">Go home</ButtonLink>;

export default function BoardPage() {
  const { boardId } = useParams<{ boardId: string }>();
  // Going from one board to another (a notification's Open button, back and forward)
  // keeps this page mounted. Keyed, each board gets its own editor and sync state, so
  // edits not sent yet can't end up on the other board, nor can its title, role or view.
  // The assertion: the router types a parameter as possibly missing, but this page's route always has one.
  return <OpenBoard key={boardId} boardId={boardId!} />;
}

function OpenBoard({ boardId }: OpenBoardProps) {
  const location = useLocation();
  const { user } = useAuth(); // null for guests viewing a shared link
  const exit = user ? backToBoards : goHome;
  const store = useMemo(createEditorStore, []);
  const sync = useBoardSync(boardId, store, { selfId: user?.id ?? getGuest().id });

  useEffect(() => {
    document.title = sync.meta ? `${sync.meta.title} · ${APP_NAME}` : APP_NAME;
    return () => {
      document.title = APP_NAME;
    };
  }, [sync.meta]);

  const { phase } = sync;

  if (phase.name === "error") {
    if (phase.locked === "password") {
      return (
        <FullPageMessage icon={KeyRound} title="This board needs a password">
          Enter the password its owner gave you with the link.
          <LinkPasswordForm onUnlock={sync.unlock} />
        </FullPageMessage>
      );
    }
    if (phase.locked === "expired") {
      return (
        <FullPageMessage icon={TimerOff} title="This link has expired" action={exit}>
          Ask the board's owner for a new link, or to invite you.
        </FullPageMessage>
      );
    }
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
