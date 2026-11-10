import clsx from "clsx";
import { REACTION_EMOJI } from "@inkboard/shared/limits";
import { Check, RotateCcw, SmilePlus, Trash2, X } from "lucide-react";
import { Fragment, useState } from "react";
import { Avatar } from "../../../components/Avatar";
import { Button, IconButton } from "../../../components/Button";
import type { Person, Thread, ThreadMessage } from "../../../lib/api";
import { timeAgo } from "../../../lib/format";
import { useMinute } from "../../../hooks/useMinute";
import type { NewMessage } from "../hooks/useThreads";
import { splitMentions } from "../lib/mentions";
import { Composer } from "./CommentComposer";

interface MessageBodyProps {
  message: ThreadMessage;
}

function MessageBody({ message }: MessageBodyProps) {
  const names = message.mentions.map((person) => person.name);
  if (names.length === 0) return <>{message.body}</>;
  return splitMentions(message.body, names).map((piece, index) =>
    piece.mention ? (
      <span key={index} className="rounded bg-signal/12 px-0.5 font-medium text-signal">
        {piece.text}
      </span>
    ) : (
      <Fragment key={index}>{piece.text}</Fragment>
    ),
  );
}

interface ReactionsProps {
  message: ThreadMessage;
  selfId: string;
  canReact: boolean;
  onReact: (emoji: string, on: boolean) => void;
}

function Reactions({ message, selfId, canReact, onReact }: ReactionsProps) {
  const [picking, setPicking] = useState(false);
  const reactions = message.reactions ?? []; // a server from before reactions sends none
  if (!canReact && reactions.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {reactions.map(({ emoji, people }) => {
        const mine = people.some((person) => person.id === selfId);
        const names = people.map((person) => person.name).join(", ");
        return (
          <button
            key={emoji}
            type="button"
            aria-pressed={mine}
            disabled={!canReact}
            title={names}
            aria-label={`${emoji} ${people.length}: ${names}`}
            onClick={() => onReact(emoji, !mine)}
            className={clsx(
              "flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors disabled:cursor-default",
              mine
                ? "border-signal bg-signal/10 font-medium text-signal"
                : "border-rule enabled:hover:border-graphite/60",
            )}
          >
            <span aria-hidden>{emoji}</span>
            <span aria-hidden>{people.length}</span>
          </button>
        );
      })}
      {canReact &&
        (picking ? (
          <span role="group" aria-label="Pick a reaction" className="flex items-center gap-0.5">
            {REACTION_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`React with ${emoji}`}
                onClick={() => {
                  setPicking(false);
                  const mine = reactions.some(
                    (reaction) => reaction.emoji === emoji && reaction.people.some((person) => person.id === selfId),
                  );
                  if (!mine) onReact(emoji, true);
                }}
                className="grid size-6 place-items-center rounded-full text-sm hover:bg-ink/8"
              >
                {emoji}
              </button>
            ))}
            <IconButton label="Close reactions" icon={X} size="sm" onClick={() => setPicking(false)} />
          </span>
        ) : (
          <IconButton
            label="Add a reaction"
            icon={SmilePlus}
            size="sm"
            onClick={() => setPicking(true)}
            className="size-6 text-graphite"
          />
        ))}
    </div>
  );
}

interface ThreadViewProps {
  thread: Thread;
  canComment: boolean;
  canResolve: boolean;
  canDelete: boolean;
  members: Person[];
  selfId: string;
  onReply: (message: NewMessage) => Promise<void>;
  onReact: (messageId: string, emoji: string, on: boolean) => void;
  onResolve: (resolved: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function ThreadView({
  thread,
  canComment,
  canResolve,
  canDelete,
  members,
  selfId,
  onReply,
  onReact,
  onResolve,
  onDelete,
  onClose,
}: ThreadViewProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useMinute();

  return (
    <>
      <div className="flex items-center justify-between gap-1 border-b border-rule px-3 py-2">
        <span className="text-sm font-semibold">{thread.resolved ? "Resolved" : "Comment"}</span>
        <div className="flex items-center">
          {canResolve && (
            <IconButton
              label={thread.resolved ? "Reopen thread" : "Resolve thread"}
              icon={thread.resolved ? RotateCcw : Check}
              size="sm"
              onClick={() => onResolve(!thread.resolved)}
            />
          )}
          {canDelete && (
            <IconButton
              label="Delete thread"
              icon={Trash2}
              size="sm"
              onClick={() => setConfirmingDelete(true)}
              className="text-danger"
            />
          )}
          <IconButton label="Close" icon={X} size="sm" onClick={onClose} />
        </div>
      </div>
      {confirmingDelete && (
        <div className="border-b border-rule bg-surface-2 px-3 py-2.5">
          <p className="text-sm">
            Delete this thread{thread.messages.length > 1 ? ` and its ${thread.messages.length} messages` : ""}? This
            can't be undone.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="secondary" size="sm" autoFocus onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete}>
              Delete
            </Button>
          </div>
        </div>
      )}
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
              <Reactions
                message={message}
                selfId={selfId}
                canReact={canComment}
                onReact={(emoji, on) => onReact(message.id, emoji, on)}
              />
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
