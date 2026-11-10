import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { DialogName } from "../constants/editor";
import type { BoardMeta, Role } from "../../../lib/api";

interface LinkedPanelsOptions {
  role: Role;
  isMember: boolean;
  local: boolean;
  board: BoardMeta;
  setDialog: (dialog: DialogName) => void;
}

// Opens something when the address asks for it, also when the board is already open (a new location.key). Runs when
// `deps` change, during render, so an effect doesn't have to set the open state.
function useOpenOnLink(deps: string, linked: boolean, open: () => void) {
  const [seen, setSeen] = useState<string | null>(null);
  if (seen !== deps) {
    setSeen(deps);
    if (linked) open();
  }
}

export function useLinkedPanels({ role, isMember, local, board, setDialog }: LinkedPanelsOptions) {
  const navigate = useNavigate();
  const location = useLocation();
  const [historyOpen, setHistoryOpen] = useState(false);
  // ?history (linked from a mass-removal warning) opens the version history.
  const linkedHistory = new URLSearchParams(location.search).has("history");
  useOpenOnLink(String(linkedHistory) + location.key, linkedHistory, () => setHistoryOpen(true));
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  // ?suggestions (linked from a notification) opens suggestions, also when the board is already open.
  const linkedSuggestions = new URLSearchParams(location.search).has("suggestions");
  useOpenOnLink(String(linkedSuggestions) + location.key, linkedSuggestions, () => setSuggestionsOpen(true));
  // ?invite=<email> (from an access request) opens the Share dialog with the address filled in.
  const linkedInvite = new URLSearchParams(location.search).get("invite");
  useOpenOnLink(`${linkedInvite}:${role}:${location.key}`, linkedInvite !== null && role === "owner", () =>
    setDialog("share"),
  );
  // ?replay opens the board's replay, for members and for link visitors the owner lets.
  const canReplay = !local && (isMember || board.linkReplay);
  const linkedReplay = new URLSearchParams(location.search).has("replay");
  const [replayOpen, setReplayOpen] = useState(false);
  useOpenOnLink(String(linkedReplay) + location.key, linkedReplay, () => setReplayOpen(true));
  const closeReplay = () => {
    setReplayOpen(false);
    if (linkedReplay) navigate(location.pathname, { replace: true }); // so coming back doesn't open it again
  };

  const toggleSuggestions = () => {
    setHistoryOpen(false);
    setSuggestionsOpen((open) => !open);
  };
  const openHistory = () => {
    setSuggestionsOpen(false);
    setHistoryOpen(true);
  };

  return {
    historyOpen,
    setHistoryOpen,
    suggestionsOpen,
    setSuggestionsOpen,
    toggleSuggestions,
    openHistory,
    linkedInvite,
    canReplay,
    replayOpen,
    setReplayOpen,
    closeReplay,
  };
}

export type LinkedPanels = ReturnType<typeof useLinkedPanels>;
