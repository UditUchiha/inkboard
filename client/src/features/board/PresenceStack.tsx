import clsx from "clsx";
import { Avatar } from "../../components/Avatar";
import type { Peer } from "./useBoardSync";

const MAX_SHOWN = 4;

type PresenceStackProps = {
  people: Peer[];
  // The socket id of the person being followed.
  followingId: string | null;
  onFollow: (socketId: string | null) => void;
};

/**
 * Who else is on the board. Clicking someone follows their view; clicking
 * them again stops. `people` come from presence: { socketId, userId, name, color, avatarUrl, guest }.
 */
export function PresenceStack({ people, followingId, onFollow }: PresenceStackProps) {
  const shown = people.slice(0, MAX_SHOWN);
  const extra = people.length - shown.length;

  return (
    <ul className="flex items-center -space-x-1.5" aria-label="People on this board">
      {shown.map((person) => {
        const following = followingId === person.socketId;
        return (
          <li key={person.socketId}>
            <button
              type="button"
              onClick={() => onFollow(following ? null : person.socketId)}
              aria-pressed={following}
              aria-label={following ? `Stop following ${person.name}` : `Follow ${person.name}`}
              title={
                following
                  ? `Following ${person.name}. Click to stop`
                  : `${person.name}${person.guest ? " (guest)" : ""}. Click to follow their view`
              }
              className={clsx(
                "block rounded-full transition-transform hover:z-10 hover:-translate-y-0.5 focus-visible:z-10",
                following && "z-10 ring-2 ring-signal ring-offset-2 ring-offset-paper",
              )}
            >
              <Avatar
                id={person.userId}
                name={person.name}
                color={person.color}
                src={person.avatarUrl}
                size="sm"
                title=""
              />
            </button>
          </li>
        );
      })}
      {extra > 0 && (
        <li
          className="inline-grid size-8 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-graphite ring-2 ring-surface"
          title={`${extra} more`}
        >
          +{extra}
        </li>
      )}
    </ul>
  );
}
