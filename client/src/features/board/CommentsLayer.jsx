import clsx from "clsx";
import { Check, RotateCcw, Trash2, X } from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "../../components/Avatar";
import { Button, IconButton } from "../../components/Button";
import { timeAgo } from "../../lib/format";
import { toScreen } from "./geometry";
import { MentionTextarea } from "./MentionTextarea";

const POPOVER_WIDTH = 320;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Mentions are shown highlighted.
function MessageBody({ message }) {
  const names = message.mentions.map((person) => person.name);
  if (names.length === 0) return <>{message.body}</>;
  const pattern = new RegExp(`(@(?:${names.map(escapeRegExp).join("|")}))`, "g");
  return message.body.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} className="rounded bg-signal/12 px-0.5 font-medium text-signal">
        {part}
      </span>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

function Pin({ thread, point, active, onClick }) {
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

function Popover({ point, size, label, onClose, children }) {
  // The pin is 36px wide and sits right of the point it marks, so clear it on either side.
  const left = point.x + 48 + POPOVER_WIDTH > size.width ? Math.max(8, point.x - 12 - POPOVER_WIDTH) : point.x + 48;
  const top = Math.min(Math.max(point.y - 40, 64), Math.max(64, size.height - 360));
  return (
    <div
      role="dialog"
      aria-label={label}
      onKeyDown={(event) => event.key === "Escape" && onClose()}
      className="floating-panel pointer-events-auto absolute z-10 rounded-xl"
      style={{ left, top, width: Math.min(POPOVER_WIDTH, size.width - 16) }}
    >
      {children}
    </div>
  );
}

function Composer({ members, submitLabel, placeholder, onSubmit, autoFocus }) {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState([]);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit({ body: text.trim(), mentions });
      setText("");
      setMentions([]);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 p-3">
      <MentionTextarea
        text={text}
        mentions={mentions}
        members={members}
        onChange={(nextText, nextMentions) => {
          setText(nextText);
          setMentions(nextMentions);
        }}
        onSubmit={submit}
        placeholder={placeholder}
        autoFocus={autoFocus}
        label={placeholder}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-graphite">{members.length > 0 ? "Type @ to mention someone" : ""}</span>
        <Button size="sm" loading={busy} disabled={!text.trim()} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function ThreadView({ thread, canComment, canDelete, members, onReply, onResolve, onDelete, onClose }) {
  return (
    <>
      <div className="flex items-center justify-between gap-1 border-b border-rule px-3 py-2">
        <span className="text-sm font-semibold">{thread.resolved ? "Resolved" : "Comment"}</span>
        <div className="flex items-center">
          {canComment && (
            <IconButton
              label={thread.resolved ? "Reopen thread" : "Resolve thread"}
              icon={thread.resolved ? RotateCcw : Check}
              size="sm"
              onClick={() => onResolve(!thread.resolved)}
            />
          )}
          {canDelete && (
            <IconButton label="Delete thread" icon={Trash2} size="sm" onClick={onDelete} className="text-danger" />
          )}
          <IconButton label="Close" icon={X} size="sm" onClick={onClose} />
        </div>
      </div>
      <ul className="max-h-64 divide-y divide-rule overflow-y-auto">
        {thread.messages.map((message) => (
          <li key={message.id} className="flex gap-2.5 px-3 py-2.5">
            <Avatar
              id={message.author.id}
              name={message.author.name}
              color={message.author.color}
              src={message.author.avatarUrl}
              size="xs"
              decorative
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="font-semibold">{message.author.name}</span>{" "}
                <span className="text-xs text-graphite">{timeAgo(message.createdAt)}</span>
              </p>
              <p className="text-sm break-words whitespace-pre-wrap">
                <MessageBody message={message} />
              </p>
            </div>
          </li>
        ))}
      </ul>
      {canComment && (
        <div className="border-t border-rule">
          <Composer members={members} submitLabel="Reply" placeholder="Reply…" onSubmit={onReply} />
        </div>
      )}
    </>
  );
}

/**
 * Comment pins over the canvas, plus the popover for the open thread or the
 * box for a new one. `members` are the people who can be @mentioned.
 */
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
  canDeleteAny,
  selfId,
  api,
}) {
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
          point={toScreen(viewport, active.x, active.y)}
          size={size}
          label="Comment thread"
          onClose={() => onActive(null)}
        >
          <ThreadView
            thread={active}
            canComment={canComment}
            canDelete={canDeleteAny || active.author.id === selfId}
            members={members}
            onReply={(input) => api.reply(active.id, input)}
            onResolve={(resolved) => api.setResolved(active.id, resolved).catch((error) => toast.error(error.message))}
            onDelete={() => {
              onActive(null);
              api.remove(active.id).catch((error) => toast.error(error.message));
            }}
            onClose={() => onActive(null)}
          />
        </Popover>
      )}
    </div>
  );
}
