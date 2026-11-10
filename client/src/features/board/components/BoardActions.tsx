import { MessageSquarePlus, Save, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../../components/Button";
import type { AccountUser } from "../../../lib/api";
import type { AppSocket } from "../../../providers/SocketProvider";
import type { Peer } from "../hooks/useBoardSync";
import { GuestIdentity } from "./GuestIdentity";
import { PresenceStack } from "./PresenceStack";

export interface BoardActionsProps {
  people: Peer[];
  followingId: string | null;
  onFollow: (socketId: string | null) => void;
  user: AccountUser | null;
  local: { onSave: () => void } | null;
  guestVersion: number;
  socket: AppSocket | null;
  suggestionCount: number;
  showSuggestionsButton: boolean;
  suggestionsOpen: boolean;
  onToggleSuggestions: () => void;
  onShare: () => void;
  // The board's "..." menu.
  children: ReactNode;
}

// Top right: people, share, menu.
export function BoardActions({
  people,
  followingId,
  onFollow,
  user,
  local,
  guestVersion,
  socket,
  suggestionCount,
  showSuggestionsButton,
  suggestionsOpen,
  onToggleSuggestions,
  onShare,
  children,
}: BoardActionsProps) {
  return (
    <div className="absolute top-3 right-3 flex items-center gap-2">
      {people.length > 0 && (
        <div className="max-sm:hidden">
          <PresenceStack people={people} followingId={followingId} onFollow={onFollow} />
        </div>
      )}
      {!user && !local && <GuestIdentity key={guestVersion} socket={socket} />}
      {showSuggestionsButton && (
        <Button
          variant="secondary"
          icon={MessageSquarePlus}
          onClick={onToggleSuggestions}
          aria-pressed={suggestionsOpen}
          className="max-sm:px-3"
        >
          <span className="max-sm:sr-only">Suggestions</span>
          {suggestionCount > 0 && (
            <span className="rounded-full bg-signal px-1.5 text-xs leading-5 font-semibold text-white">
              {suggestionCount}
            </span>
          )}
        </Button>
      )}
      {local ? (
        <Button icon={Save} onClick={local.onSave} className="max-sm:px-3">
          <span className="max-sm:sr-only">Save board</span>
        </Button>
      ) : (
        <Button icon={UserPlus} onClick={onShare} className="max-sm:px-3">
          <span className="max-sm:sr-only">Share</span>
        </Button>
      )}
      {children}
    </div>
  );
}
