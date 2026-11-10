import type { Element as BoardElement } from "@inkboard/shared/types";
import { useEffect } from "react";
import { toast } from "sonner";
import type { ToolId } from "../constants/board";
import type { XY } from "../lib/elements/geometry";
import type { BoardStore } from "../lib/sync/store";
import { voteFor, voteTarget } from "../components/Voting";
import type { BoardSync } from "./useBoardSync";

interface VotingToolOptions {
  store: BoardStore;
  sync: BoardSync;
  readOnly: boolean;
  setTool: (update: (current: ToolId) => ToolId) => void;
  changeTool: (tool: ToolId) => void;
}

export function useVotingTool({ store, sync, readOnly, setTool, changeTool }: VotingToolOptions) {
  // While a voting round is open everyone's pointer votes; when it ends the tool goes back (see Voting.tsx).
  const votingOpen = Boolean(sync.voting?.open);
  useEffect(() => {
    if (votingOpen) changeTool("vote");
    else setTool((current) => (current === "vote" ? (readOnly ? "hand" : "select") : current));
  }, [votingOpen, readOnly, changeTool, setTool]);

  return function castVote(point: XY, hit: BoardElement | null) {
    const element = voteTarget(store.getElements(), point, hit);
    const choice = element && voteFor(sync.voting, element);
    if (choice && "refused" in choice) toast(choice.refused);
    else if (choice) sync.vote(choice);
  };
}
