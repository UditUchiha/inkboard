import type { Element as BoardElement } from "@inkboard/shared/types";
import { useLocation } from "react-router";
import { api } from "../../../lib/api";
import type { AccountUser, Role } from "../../../lib/api";
import type { ToolId } from "../constants/board";
import { isFrame } from "../lib/elements/elements";
import type { BoardSync } from "../hooks/useBoardSync";
import { drawsOnBoard } from "../hooks/useBoardSync";
import { BoardTimer } from "./BoardTimer";
import { ClassroomNotice } from "./ClassroomPanels";
import { PrivateModeNotice, SuggestingNotice, ViewOnlyNotice } from "./StatusPanels";
import { Toolbar } from "./Toolbar";
import { VotingBar } from "./Voting";

export interface ToolbarStackProps {
  sync: BoardSync;
  boardId: string;
  user: AccountUser | null;
  role: Role;
  local: boolean;
  tool: ToolId;
  onToolChange: (tool: ToolId) => void;
  readOnly: boolean;
  suggesting: boolean;
  student: boolean;
  isMember: boolean;
  canComment: boolean;
  onAddImage?: (() => void) | undefined;
  onAddEquation: () => void;
  onAiDraw?: (() => void) | undefined;
  elements: BoardElement[];
  elementById: ReadonlyMap<string, BoardElement>;
  classroom: BoardSync["classroom"];
  classroomOn: boolean;
  myFrameName: string | null;
  onGoToMyFrame: () => void;
}

// Tools: top centre on wide screens, bottom on phones.
export function ToolbarStack({
  sync,
  boardId,
  user,
  role,
  local,
  tool,
  onToolChange,
  readOnly,
  suggesting,
  student,
  isMember,
  canComment,
  onAddImage,
  onAddEquation,
  onAiDraw,
  elements,
  elementById,
  classroom,
  classroomOn,
  myFrameName,
  onGoToMyFrame,
}: ToolbarStackProps) {
  const location = useLocation();

  return (
    <div className="absolute inset-x-3 bottom-3 flex flex-col-reverse items-center gap-2 md:inset-x-auto md:top-3 md:bottom-auto md:left-1/2 md:-translate-x-1/2 md:flex-col">
      {readOnly ? (
        <ViewOnlyNotice
          signedIn={Boolean(user)}
          loginHref={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
          commenting={canComment ? tool === "comment" : undefined}
          onToggleComment={() => onToolChange(tool === "comment" ? "hand" : "comment")}
          onRequestEdit={user && !local ? () => api.requestAccess(boardId) : undefined}
        />
      ) : (
        <Toolbar
          tool={tool}
          onToolChange={onToolChange}
          onAddImage={onAddImage}
          onAddEquation={onAddEquation}
          onAiDraw={onAiDraw}
          withComments={canComment}
          withoutFrames={student}
          className="max-md:max-w-full max-md:overflow-x-auto"
        />
      )}
      {classroomOn && isMember && (
        <ClassroomNotice
          teacher
          claimed={classroom!.claims.filter((claim) => elementById.get(claim.frameId)).length}
          frames={elements.filter(isFrame).length}
          onEnd={() => void sync.changeClassroom({ action: "stop" })}
        />
      )}
      {student && <ClassroomNotice teacher={false} frameName={myFrameName} onGoTo={onGoToMyFrame} />}
      {sync.privateMode ? (
        <PrivateModeNotice
          by={sync.privateMode.by}
          hidden={suggesting}
          onReveal={sync.privateMode.canEnd ? () => sync.setPrivate(false) : undefined}
        />
      ) : (
        suggesting && <SuggestingNotice />
      )}
      {!local && <BoardTimer timer={sync.timer} canControl={drawsOnBoard(role)} onControl={sync.controlTimer} />}
      {sync.voting && (
        <VotingBar
          voting={sync.voting}
          canRun={drawsOnBoard(role)}
          voteToolOn={tool === "vote"}
          onVoteTool={() => onToolChange("vote")}
          onEnd={() => sync.vote({ action: "end" })}
          onClear={() => sync.vote({ action: "clear" })}
        />
      )}
    </div>
  );
}
