import { FileQuestion, KeyRound, Lock, Maximize, TimerOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { buttonClass, IconButton } from "../components/Button";
import { LogoMark } from "../components/Logo";
import { FullPageLoader, FullPageMessage } from "../components/RouteGuards";
import { APP_NAME } from "../config";
import { BoardCanvas } from "../features/board/BoardCanvas";
import { DEFAULT_STYLE } from "../features/board/constants";
import { createEditorStore } from "../features/board/editorStore";
import { getSceneBounds } from "../features/board/elements";
import { fitViewport } from "../features/board/geometry";
import type { Size, Viewport } from "../features/board/geometry";
import { useBoardSync } from "../features/board/useBoardSync";
import { getGuest } from "../lib/guest";

const NOOP = () => {};

/**
 * A board shown on another site, in an <iframe> (the snippet is in the Share dialog). It's the board live, to look
 * at, pan and zoom: never edited, whatever the link allows, and the people on the board aren't shown it (the server
 * makes sure of both, see `embed` in JoinPayload). Only boards whose link is shared open here, since a site's frame
 * doesn't share the app's sign-in.
 */
export default function EmbedPage() {
  const { boardId } = useParams<{ boardId: string }>();
  // The assertion: the route always has the parameter.
  return <EmbeddedBoard key={boardId} boardId={boardId!} />;
}

function EmbeddedBoard({ boardId }: { boardId: string }) {
  const store = useMemo(createEditorStore, []);
  const sync = useBoardSync(boardId, store, { selfId: getGuest().id, embed: true });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const boardUrl = `${window.location.origin}/board/${boardId}`;
  const ready = sync.phase.name === "ready";

  const fit = useCallback(() => {
    const bounds = getSceneBounds(store.getElements());
    if (bounds) setViewport(fitViewport(bounds, size, { padding: 24, maxZoom: 1 }));
  }, [store, size]);
  // The whole drawing in view once it's there, then wherever the visitor pans and zooms.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !ready || !size.width) return;
    fitted.current = true;
    fit();
  }, [ready, size, fit]);

  useEffect(() => {
    document.title = sync.meta ? `${sync.meta.title} · ${APP_NAME}` : APP_NAME;
  }, [sync.meta]);

  const open = (
    <a href={boardUrl} target="_blank" rel="noopener" className={buttonClass({ variant: "secondary" })}>
      Open in {APP_NAME}
    </a>
  );
  const { phase } = sync;
  if (phase.name === "error") {
    if (phase.locked === "password") {
      return (
        <FullPageMessage icon={KeyRound} title="This board needs a password" action={open}>
          Open it in {APP_NAME} to enter it.
        </FullPageMessage>
      );
    }
    if (phase.locked === "expired") {
      return <FullPageMessage icon={TimerOff} title="This board's link has expired" />;
    }
    if (phase.status === 401 || phase.status === 403) {
      return (
        <FullPageMessage icon={Lock} title="This board isn't shared" action={open}>
          Its owner hasn't shared its link, so it can't be shown here.
        </FullPageMessage>
      );
    }
    return <FullPageMessage icon={FileQuestion} title="This board doesn't exist" />;
  }
  if (phase.name === "deleted") return <FullPageMessage icon={FileQuestion} title="This board was deleted" />;
  if (phase.name === "revoked") {
    return (
      <FullPageMessage icon={Lock} title="This board isn't shared any more" action={open}>
        Its owner stopped sharing its link.
      </FullPageMessage>
    );
  }
  if (!ready) return <FullPageLoader label="Opening board" />;

  return (
    <div className="fixed inset-0 overflow-hidden select-none">
      <BoardCanvas
        store={store}
        tool="hand"
        style={DEFAULT_STYLE}
        viewport={viewport}
        onViewportChange={setViewport}
        selectedId={null}
        onSelect={NOOP}
        onEditText={NOOP}
        spacePressed={false}
        onCursorMove={NOOP}
        onSizeChange={setSize}
      />
      <div className="absolute right-2 bottom-2 flex items-center gap-1">
        <div className="floating-panel rounded-xl p-1">
          <IconButton label="Fit drawing to screen" icon={Maximize} onClick={fit} size="sm" />
        </div>
        <a
          href={boardUrl}
          target="_blank"
          rel="noopener"
          title={`Open “${sync.meta?.title}” in ${APP_NAME}`}
          className="floating-panel flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium transition-colors hover:bg-surface-2"
        >
          <LogoMark className="size-5" />
          Open in {APP_NAME}
        </a>
      </div>
    </div>
  );
}
