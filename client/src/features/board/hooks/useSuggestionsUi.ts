import type { Element as BoardElement } from "@inkboard/shared/types";
import { useMemo, useState } from "react";
import { idsInGroup, useSuggestionReview } from "../components/SuggestionsPanel";
import type { Rect, Size, Viewport } from "../lib/elements/geometry";
import { useBoardSnapshot } from "../lib/sync/store";
import type { BoardStore } from "../lib/sync/store";
import { suggestionMarks } from "../lib/sync/suggestions";
import type { OwnSuggestions, SuggestionGroup } from "../lib/sync/suggestions";
import type { BoardSync } from "./useBoardSync";

interface SuggestionsUiOptions {
  sync: BoardSync;
  store: BoardStore;
  getElement: (id: string) => BoardElement | undefined;
  selfId: string;
  suggesting: boolean;
  canvasSize: Size;
  changeViewport: (next: (current: Viewport) => Viewport) => void;
}

export function useSuggestionsUi({
  sync,
  store,
  getElement,
  selfId,
  suggesting,
  canvasSize,
  changeViewport,
}: SuggestionsUiOptions) {
  const review = useSuggestionReview(sync, store);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
  // A suggester's screen shows the board with their suggestions in it; this is the board without them (see suggesting.ts).
  const { elements: underneath } = useBoardSnapshot(sync.suggestedOver);
  const underneathById = useMemo(() => new Map(underneath.map((element) => [element.id, element])), [underneath]);
  const boardWithout = suggesting ? (id: string) => underneathById.get(id) : getElement;
  const isOwnGroup = (group: SuggestionGroup) => suggesting && group.author.userId === selfId;
  const withdraw = (group: SuggestionGroup) => sync.withdrawSuggestions(group.suggestions.map(({ id }) => id));
  const highlighted = useMemo(() => idsInGroup(review.groups, hoveredGroup), [review.groups, hoveredGroup]);
  const suggestionLayer = useMemo(() => {
    if (!showSuggestions) return undefined;
    const own: OwnSuggestions | undefined = suggesting
      ? { isOwn: (suggestion) => suggestion.author.userId === selfId, underneath: (id) => underneathById.get(id) }
      : undefined;
    return suggestionMarks(review.suggestions, getElement, highlighted, own);
  }, [showSuggestions, suggesting, selfId, review.suggestions, getElement, underneathById, highlighted]);
  const focusOn = (bounds: Rect) =>
    changeViewport((vp) => ({
      ...vp,
      x: canvasSize.width / 2 / vp.zoom - (bounds.x + bounds.width / 2),
      y: canvasSize.height / 2 / vp.zoom - (bounds.y + bounds.height / 2),
    }));

  return {
    review,
    showSuggestions,
    setShowSuggestions,
    setHoveredGroup,
    boardWithout,
    isOwnGroup,
    withdraw,
    suggestionLayer,
    focusOn,
  };
}

export type SuggestionsUi = ReturnType<typeof useSuggestionsUi>;
