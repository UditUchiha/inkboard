import { EyeOff, GraduationCap, Keyboard } from "lucide-react";
import { IconButton } from "../../../components/Button";
import type { Role } from "../../../lib/api";
import { drawsOnBoard } from "../hooks/useBoardSync";
import type { BoardSync } from "../hooks/useBoardSync";
import { StartTimer } from "./BoardTimer";
import { SyncStatus } from "./StatusPanels";
import { StartVoting } from "./Voting";

export interface BoardCornerToolsProps {
  sync: BoardSync & { unsaved?: boolean };
  role: Role;
  local: boolean;
  readOnly: boolean;
  isMember: boolean;
  classroomOn: boolean;
  onStartClassroom: () => void;
  onShortcuts: () => void;
}

// Bottom right: save status, and the buttons that start a shared mode.
export function BoardCornerTools({
  sync,
  role,
  local,
  readOnly,
  isMember,
  classroomOn,
  onStartClassroom,
  onShortcuts,
}: BoardCornerToolsProps) {
  return (
    <div className="absolute right-3 bottom-[7.5rem] flex items-center gap-2 sm:bottom-[4.25rem] md:bottom-3">
      <SyncStatus online={sync.online} saving={sync.saving} readOnly={readOnly} local={local} unsaved={sync.unsaved} />
      {!local && drawsOnBoard(role) && !sync.timer && (
        <div className="floating-panel rounded-xl p-1">
          <StartTimer onStart={(seconds) => sync.controlTimer({ action: "start", seconds })} />
        </div>
      )}
      {!local && drawsOnBoard(role) && !sync.voting && (
        <div className="floating-panel rounded-xl p-1">
          <StartVoting onStart={(votes) => sync.vote({ action: "start", votes })} />
        </div>
      )}
      {!local && isMember && !classroomOn && (
        <div className="floating-panel rounded-xl p-1">
          <IconButton
            label="Classroom mode: each student draws only in a frame they claim"
            icon={GraduationCap}
            onClick={onStartClassroom}
          />
        </div>
      )}
      {!local && isMember && !sync.privateMode && (
        <div className="floating-panel rounded-xl p-1">
          <IconButton
            label="Private mode: hide what everyone adds until you reveal it"
            icon={EyeOff}
            onClick={() => sync.setPrivate(true)}
          />
        </div>
      )}
      <div className="floating-panel rounded-xl p-1 max-md:hidden">
        <IconButton label="Keyboard shortcuts" icon={Keyboard} onClick={onShortcuts} />
      </div>
    </div>
  );
}
