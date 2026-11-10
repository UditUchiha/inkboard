import clsx from "clsx";
import { Check, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Avatar } from "../../../components/Avatar";
import { IconButton } from "../../../components/Button";
import { errorMessage } from "../../../lib/api";
import type { Person, Thread } from "../../../lib/api";
import { toScreen } from "../lib/elements/geometry";
import type { Size, Viewport, XY } from "../lib/elements/geometry";
import { isComposing } from "../lib/mentions";
import { focusAfterClose } from "../lib/popoverFocus";
import type { ThreadApi } from "../hooks/useThreads";
import { Composer } from "./CommentComposer";
import { ThreadView } from "./ThreadView";

const POPOVER_WIDTH = 320;

type PinProps = { thread: Thread; point: XY; active: boolean; onClick: () => void };

function Pin({ thread, point, active, onClick }: PinProps) {
  const count = thread.messages.length;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Comment by ${thread.author.name}, ${count} ${count === 1 ? "message" : "messages"}${thread.resolved ? ", resolved" : ""}`}
      aria-expanded={active}
      className={clsx(
        "pointer-events-auto absolute top-0 left-0 grid size-9 place-items-center rounded-full rounded-bl-none shadow-md ring-2 transition-opacity",
        active ? "ring-signal" : "ring-surface",
        thread.resolved && !active && "opacity-55",
      )}
      style={{ transform: `translate(${point.x}px, ${point.y}px) translateY(-100%)` }}
    >
      <Avatar
        id={thread.author.id}
        name={thread.author.name}
        color={thread.author.color}
        src={thread.author.avatarUrl}
        size="sm"
        className="ring-0"
        title=""
      />
      {thread.resolved ? (
        <span className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-[#2f9e44] text-white">
          <Check className="size-3" strokeWidth={3} aria-hidden />
        </span>
      ) : (
        count > 1 && (
          <span className="absolute -top-1.5 -right-1.5 grid min-w-4 place-items-center rounded-full bg-ink px-1 text-[10px] leading-4 font-semibold text-on-ink">
            {count}
          </span>
        )
      )}
    </button>
  );
}

type PopoverProps = { point: XY; size: Size; label: string; onClose: () => void; children: ReactNode };

function Popover({ point, size, label, onClose, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Focus before the popover opened, read on first render: by effect time an autoFocus field has already taken it.
  // the cast: what has focus is an HTMLElement (only focus() is used)
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  // Keyboard users land in the popover (unless a field in it already took focus).
  useEffect(() => {
    // The assertions: effects run once the popover is on the page.
    if (!ref.current!.contains(document.activeElement)) ref.current!.focus({ preventScroll: true });
  }, []);

  // Focus goes back only if it is still inside as the popover closes, checked before it leaves the page
  // (removing a focused element drops focus to the body). Moved a tick later so React dev's effect remount
  // doesn't pull focus out of the field that just took it.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const popover = ref.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      const target = focusAfterClose(popover, document.activeElement, opener);
      if (target) queueMicrotask(() => !mounted.current && target.isConnected && target.focus({ preventScroll: true }));
    };
  }, [opener]);

  // The pin is 36px wide and sits right of its point, so clear it on either side.
  const left = point.x + 48 + POPOVER_WIDTH > size.width ? Math.max(8, point.x - 12 - POPOVER_WIDTH) : point.x + 48;
  const top = Math.min(Math.max(point.y - 40, 64), Math.max(64, size.height - 360));
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      // Escape while an input method is composing cancels the composition, not the comment.
      onKeyDown={(event) => event.key === "Escape" && !isComposing(event) && onClose()}
      className="floating-panel pointer-events-auto absolute z-10 rounded-xl focus:outline-none"
      style={{ left, top, width: Math.min(POPOVER_WIDTH, size.width - 16) }}
    >
      {children}
    </div>
  );
}

type CommentsLayerProps = {
  threads: Thread[];
  viewport: Viewport;
  size: Size;
  activeId: string | null;
  onActive: (id: string | null) => void;
  draft: XY | null;
  onDraftClose: () => void;
  members: Person[];
  canComment: boolean;
  canResolveAny: boolean;
  canDeleteAny: boolean;
  selfId: string;
  api: ThreadApi;
};

export function CommentsLayer({
  threads,
  viewport,
  size,
  activeId,
  onActive,
  draft,
  onDraftClose,
  members,
  canComment,
  canResolveAny,
  canDeleteAny,
  selfId,
  api,
}: CommentsLayerProps) {
  const active = threads.find((thread) => thread.id === activeId);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {threads.map((thread) => (
        <Pin
          key={thread.id}
          thread={thread}
          point={toScreen(viewport, thread.x, thread.y)}
          active={thread.id === activeId}
          onClick={() => onActive(thread.id === activeId ? null : thread.id)}
        />
      ))}

      {draft && (
        <>
          <span
            className="pointer-events-none absolute top-0 left-0 size-9 rounded-full rounded-bl-none bg-signal/80 shadow-md ring-2 ring-surface"
            style={{
              transform: `translate(${toScreen(viewport, draft.x, draft.y).x}px, ${toScreen(viewport, draft.x, draft.y).y}px) translateY(-100%)`,
            }}
            aria-hidden
          />
          <Popover point={toScreen(viewport, draft.x, draft.y)} size={size} label="New comment" onClose={onDraftClose}>
            <div className="flex items-center justify-between border-b border-rule px-3 py-2">
              <span className="text-sm font-semibold">New comment</span>
              <IconButton label="Cancel comment" icon={X} size="sm" onClick={onDraftClose} />
            </div>
            <Composer
              members={members}
              submitLabel="Comment"
              placeholder="Write a comment…"
              autoFocus
              onSubmit={async (input) => {
                await api.create({ x: draft.x, y: draft.y, ...input });
                onDraftClose();
              }}
            />
          </Popover>
        </>
      )}

      {active && !draft && (
        <Popover
          key={active.id}
          point={toScreen(viewport, active.x, active.y)}
          size={size}
          label="Comment thread"
          onClose={() => onActive(null)}
        >
          <ThreadView
            thread={active}
            canComment={canComment}
            canResolve={canComment && (canResolveAny || active.author.id === selfId)}
            canDelete={canDeleteAny || active.author.id === selfId}
            members={members}
            selfId={selfId}
            onReply={(input) => api.reply(active.id, input)}
            onReact={(messageId, emoji, on) =>
              api.react(active.id, messageId, emoji, on).catch((error: unknown) => toast.error(errorMessage(error)))
            }
            onResolve={(resolved) =>
              api.setResolved(active.id, resolved).catch((error: unknown) => toast.error(errorMessage(error)))
            }
            onDelete={() => {
              onActive(null);
              api.remove(active.id).catch((error: unknown) => toast.error(errorMessage(error)));
            }}
            onClose={() => onActive(null)}
          />
        </Popover>
      )}
    </div>
  );
}
