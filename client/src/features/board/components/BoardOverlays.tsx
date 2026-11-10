import type { Element as BoardElement } from "@inkboard/shared/types";
import type { Role } from "../../../lib/api";
import type { Size, Viewport } from "../lib/elements/geometry";
import { drawsOnBoard } from "../hooks/useBoardSync";
import type { BoardSync } from "../hooks/useBoardSync";
import type { CommentsUi } from "../hooks/useCommentsUi";
import type { SuggestionsUi } from "../hooks/useSuggestionsUi";
import type { TextEditing } from "../hooks/useTextEditing";
import { CommentsLayer } from "./CommentsLayer";
import { InlineTextEditor } from "./InlineTextEditor";
import { SuggestionChips } from "./SuggestionsPanel";
import { VotesLayer } from "./Voting";

export interface BoardOverlaysProps {
  sync: BoardSync;
  elements: BoardElement[];
  viewport: Viewport;
  canvasSize: Size;
  role: Role;
  selfId: string;
  isMember: boolean;
  commentsEnabled: boolean;
  canComment: boolean;
  comments: CommentsUi;
  suggestions: SuggestionsUi;
  text: TextEditing;
  getElement: (id: string) => BoardElement | undefined;
}

// What sits over the canvas: votes, comment pins, suggestion chips and the editor for a text.
export function BoardOverlays({
  sync,
  elements,
  viewport,
  canvasSize,
  role,
  selfId,
  isMember,
  commentsEnabled,
  canComment,
  comments,
  suggestions,
  text,
  getElement,
}: BoardOverlaysProps) {
  const { review } = suggestions;
  const { editing, edited } = text;

  return (
    <>
      {sync.voting && <VotesLayer voting={sync.voting} elements={elements} viewport={viewport} />}
      {commentsEnabled && comments.showComments && (
        <CommentsLayer
          threads={comments.threads}
          viewport={viewport}
          size={canvasSize}
          activeId={comments.activeThread}
          onActive={(id) => {
            comments.setDraft(null);
            comments.setActiveThread(id);
          }}
          draft={comments.draft}
          onDraftClose={() => comments.setDraft(null)}
          members={comments.members}
          canComment={canComment}
          canResolveAny={drawsOnBoard(role)}
          canDeleteAny={role === "owner"}
          selfId={selfId}
          api={comments.threadApi}
        />
      )}

      {suggestions.showSuggestions && review.groups.length > 0 && (
        <SuggestionChips
          groups={review.groups}
          viewport={viewport}
          getElement={(id) => getElement(id) ?? suggestions.boardWithout(id)}
          canDecide={isMember}
          onAccept={(group) => review.accept(group.suggestions)}
          onReject={(group) => review.reject(group.suggestions)}
          onHover={suggestions.setHoveredGroup}
          isOwn={suggestions.isOwnGroup}
          onWithdraw={suggestions.withdraw}
        />
      )}

      {editing && edited && (
        <InlineTextEditor
          editing={editing}
          edited={edited}
          elements={elements}
          viewport={viewport}
          onCommit={text.commitText}
        />
      )}
    </>
  );
}
