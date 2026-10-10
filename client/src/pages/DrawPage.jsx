import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { toast } from "sonner";
import { Button, ButtonLink } from "../components/Button";
import { FullPageLoader, FullPageMessage, RequireAuth } from "../components/RouteGuards";
import { APP_NAME } from "../config";
import { BoardEditor } from "../features/board/BoardEditor";
import { clearScratch, currentScratch, useScratchBoard } from "../features/board/scratch";
import { importScratch } from "../features/board/scratchImport";
import { useBoardSnapshot } from "../features/board/store";
import { api } from "../lib/api";
import { useAuth } from "../providers/AuthProvider";
import { useSocket } from "../providers/SocketProvider";

// /draw is the no-account whiteboard. The board is kept in this browser. Once
// someone signs up or logs in (the "Save board" button sends them to /register?next=/draw),
// they land back here and the drawing becomes their first board.

// `user` is set when someone signed in comes back here because saving their drawing failed:
// they can keep working on it, and `onSave` tries saving again.
function ScratchEditor({ user = null, onSave = null }) {
  const navigate = useNavigate();
  const { store, sync } = useScratchBoard();
  const { elements } = useBoardSnapshot(store);
  const hadDrawing = useRef(false);
  const [restored] = useState(() => currentScratch().elements.length > 0); // from an earlier visit, not new work

  useEffect(() => {
    document.title = `Draw · ${APP_NAME}`;
    return () => {
      document.title = APP_NAME;
    };
  }, []);

  const save = () => {
    if (store.getElements().length === 0) {
      toast("Draw something first, then save it.");
      return;
    }
    if (onSave) onSave();
    else navigate("/register?next=/draw");
  };

  // Once, after the first mark: say where the drawing is and how to keep it.
  useEffect(() => {
    if (elements.length === 0 || hadDrawing.current || user) return;
    hadDrawing.current = true;
    if (restored) return;
    toast("Your board is saved in this browser.", {
      description: "Create a free account to keep it safe and share it.",
      action: { label: "Save board", onClick: save },
      duration: 8000,
    });
  });

  return <BoardEditor store={store} sync={sync} user={user} local={{ onSave: save }} />;
}

// Signed in: turn the guest's drawing into a real board, then open it. If that
// fails the person can try again, or go back to the drawing (`onKeep`): it is
// still here, so nothing is lost. `created` holds a board an earlier try made, to
// be filled in rather than made again; it's kept by the page, so it outlasts going
// back to the drawing and saving from there.
function ImportScratch({ onKeep, created }) {
  const navigate = useNavigate();
  const socket = useSocket();
  const started = useRef(-1); // the try that's under way or done
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!socket) return; // a big drawing is partly uploaded over the socket
    const scratch = currentScratch();
    if (scratch.elements.length === 0) {
      navigate("/boards", { replace: true });
      return;
    }
    if (started.current === attempt) return;
    started.current = attempt;
    importScratch({
      scratch,
      createBoard: api.createBoard,
      socket,
      created: created.current,
      onCreated: (board) => {
        created.current = board;
      },
    })
      .then((board) => {
        clearScratch();
        toast.success("Your drawing is saved to your boards.");
        navigate(`/board/${board.id}`, { replace: true });
      })
      .catch((importError) => setError(importError.message));
  }, [navigate, socket, attempt, created]);

  if (error) {
    return (
      <FullPageMessage
        title="Your drawing couldn't be saved"
        action={
          <>
            <Button
              onClick={() => {
                setError("");
                setAttempt((count) => count + 1);
              }}
            >
              Try again
            </Button>
            <Button variant="secondary" onClick={onKeep}>
              Back to the drawing
            </Button>
            <ButtonLink to="/boards" variant="secondary">
              Go to your boards
            </ButtonLink>
          </>
        }
      >
        {error} Your drawing is still on this device.
      </FullPageMessage>
    );
  }
  return <FullPageLoader label="Saving your drawing" />;
}

function DrawRoute() {
  const { status, user } = useAuth();
  const [keepEditing, setKeepEditing] = useState(false);
  const created = useRef(null); // the board saving this drawing made (see ImportScratch)
  if (status === "authenticated") {
    return keepEditing ? (
      <ScratchEditor user={user} onSave={() => setKeepEditing(false)} />
    ) : (
      <ImportScratch onKeep={() => setKeepEditing(true)} created={created} />
    );
  }
  if (status === "anonymous") return <ScratchEditor />;
  return <Navigate to="/" replace />;
}

export default function DrawPage() {
  return (
    <RequireAuth optional>
      <DrawRoute />
    </RequireAuth>
  );
}
