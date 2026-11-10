import { Star, Trash2, X } from "lucide-react";
import { Button } from "../../../components/Button";
import { isMember } from "../lib/sections";
import type { BoardSummary, SECTIONS } from "../lib/sections";
import type { BoardActions } from "./BoardParts";

interface BulkBarProps {
  section: (typeof SECTIONS)[number];
  picked: BoardSummary[];
  actions: BoardActions & { starAll: (boards: BoardSummary[]) => void };
  onClear: () => void;
}

export function BulkBar({ section, picked, actions, onClear }: BulkBarProps) {
  const owned = picked.every((board) => board.role === "owner");
  const members = picked.every(isMember);
  const allStarred = picked.every((board) => board.starred);
  const trash = section.id === "trash";
  const archived = section.id === "archived";
  return (
    <div
      role="toolbar"
      aria-label="Actions for selected boards"
      className="floating-panel sticky top-20 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2"
    >
      <span className="mr-auto text-sm font-medium" aria-live="polite">
        {picked.length} selected
      </span>
      {trash ? (
        <>
          <Button size="sm" variant="secondary" onClick={() => actions.restore(picked)}>
            Restore
          </Button>
          <Button size="sm" variant="danger" onClick={() => actions.askPurge(picked)}>
            Delete forever
          </Button>
        </>
      ) : (
        <>
          <Button
            size="sm"
            variant="secondary"
            icon={Star}
            disabled={!members}
            title={members ? undefined : "Only people invited to a board can star it"}
            onClick={() => actions.starAll(picked)}
          >
            {allStarred ? "Unstar" : "Star"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => actions.archive(picked, !archived)}>
            {archived ? "Unarchive" : "Archive"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={Trash2}
            disabled={!owned}
            title={owned ? undefined : "Only the owner can move a board to the trash"}
            onClick={() => actions.trash(picked)}
          >
            Move to trash
          </Button>
        </>
      )}
      <Button size="sm" variant="ghost" icon={X} onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
