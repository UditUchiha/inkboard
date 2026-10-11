import type { SuggestionOutcome } from "@inkboard/shared/socket";
import { isOutdated } from "@inkboard/shared/suggestions";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { Check, Eye, EyeOff, MessageSquarePlus, TriangleAlert, X } from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Avatar } from "../../components/Avatar";
import { Button, IconButton } from "../../components/Button";
import { personColor, timeAgo } from "../../lib/format";
import { useMinute } from "../../lib/useMinute";
import { getSceneBounds } from "./elements";
import { toScreen } from "./geometry";
import type { Rect, Viewport } from "./geometry";
import type { BoardStore } from "./store";
import { acceptance, groupSuggestions, summarize, useSuggestions } from "./suggestions";
import type { Suggestion, SuggestionGroup, SuggestionStore } from "./suggestions";

/** What the review needs of the board's sync: its suggestions, and how to say what was decided. */
type ReviewSync = {
  suggestions: SuggestionStore;
  resolveSuggestions: (ids: string[], outcome: SuggestionOutcome) => void;
};

/**
 * The board's open suggestions, grouped, and a member's decisions on them. Accepting is the member's own change
 * to the board, one step in their history (so it can be undone like any edit), and then the decision.
 */
export function useSuggestionReview(sync: ReviewSync, store: BoardStore) {
  const suggestions = useSuggestions(sync.suggestions);
  const groups = useMemo(() => groupSuggestions(suggestions), [suggestions]);
  const { resolveSuggestions, suggestions: suggestionStore } = sync;

  const accept = useCallback(
    (list: readonly Suggestion[]) => {
      const { entry, accepted, skipped } = acceptance(list, (id) => store.getElement(id));
      if (accepted.length > 0) {
        store.commit(entry);
        resolveSuggestions(accepted, "accepted");
      }
      // About an element that went meanwhile: the server lets those go by itself.
      if (skipped.length > 0) {
        suggestionStore.remove(skipped);
        toast(
          `${skipped.length === 1 ? "A suggestion was" : "Some suggestions were"} about something no longer on the board.`,
        );
      }
    },
    [store, resolveSuggestions, suggestionStore],
  );
  const reject = useCallback(
    (list: readonly Suggestion[]) =>
      resolveSuggestions(
        list.map((suggestion) => suggestion.id),
        "rejected",
      ),
    [resolveSuggestions],
  );
  return { suggestions, groups, accept, reject };
}

/** Where a group of suggestions is on the board: around what they'd add, change or remove. */
export function groupBounds(group: SuggestionGroup, getElement: (id: string) => BoardElement | undefined): Rect | null {
  const elements = group.suggestions
    .map((suggestion) => (suggestion.kind === "add" ? suggestion.element : getElement(suggestion.target)))
    .filter((element): element is BoardElement => element !== undefined);
  return getSceneBounds(elements);
}

const authorColor = (group: SuggestionGroup) => personColor({ id: group.author.userId, color: group.author.color });

type ChipsProps = {
  groups: SuggestionGroup[];
  viewport: Viewport;
  getElement: (id: string) => BoardElement | undefined;
  canDecide: boolean;
  onAccept: (group: SuggestionGroup) => void;
  onReject: (group: SuggestionGroup) => void;
  onHover: (groupId: string | null) => void;
};

/** A label above each group of suggestions on the board: whose they are and, for members, accept and reject. */
export function SuggestionChips({ groups, viewport, getElement, canDecide, onAccept, onReject, onHover }: ChipsProps) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {groups.map((group) => {
        const bounds = groupBounds(group, getElement);
        if (!bounds) return null;
        const point = toScreen(viewport, bounds.x, bounds.y);
        return (
          <div
            key={group.id}
            onPointerEnter={() => onHover(group.id)}
            onPointerLeave={() => onHover(null)}
            className="pointer-events-auto absolute top-0 left-0 flex h-7 items-center gap-1 rounded-full border border-rule bg-surface py-0.5 pr-0.5 pl-1 text-xs shadow-sm"
            style={{ transform: `translate(${point.x}px, ${point.y - 6}px) translateY(-100%)` }}
          >
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: authorColor(group) }}
              aria-hidden
            />
            <span className="max-w-32 truncate px-0.5 font-medium">{group.author.name}</span>
            {canDecide && (
              <>
                <IconButton
                  label={`Accept ${group.author.name}'s suggestion`}
                  icon={Check}
                  size="sm"
                  className="size-6 text-signal"
                  onClick={() => onAccept(group)}
                />
                <IconButton
                  label={`Reject ${group.author.name}'s suggestion`}
                  icon={X}
                  size="sm"
                  className="size-6"
                  onClick={() => onReject(group)}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

type PanelProps = {
  groups: SuggestionGroup[];
  getElement: (id: string) => BoardElement | undefined;
  canDecide: boolean;
  shown: boolean;
  onToggleShown: () => void;
  onAccept: (suggestions: readonly Suggestion[]) => void;
  onReject: (suggestions: readonly Suggestion[]) => void;
  onHover: (groupId: string | null) => void;
  onFocus: (bounds: Rect) => void;
  onClose: () => void;
};

/** Every open suggestion, a group to a row, newest last, with the decisions a member can make on them. */
export function SuggestionsPanel({
  groups,
  getElement,
  canDecide,
  shown,
  onToggleShown,
  onAccept,
  onReject,
  onHover,
  onFocus,
  onClose,
}: PanelProps) {
  useMinute(); // keeps "2 minutes ago" current
  const all = groups.flatMap((group) => group.suggestions);
  const outdated = (suggestion: Suggestion) => {
    if (suggestion.kind === "add") return false;
    const current = getElement(suggestion.target);
    return current ? isOutdated(current, suggestion) : false;
  };

  return (
    <aside
      aria-label="Suggestions"
      className="floating-panel absolute top-16 right-3 bottom-[4.25rem] z-20 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col rounded-xl md:bottom-16"
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
        <h2 className="font-semibold">Suggestions</h2>
        <div className="flex items-center gap-0.5">
          <IconButton
            label={shown ? "Hide suggestions on the board" : "Show suggestions on the board"}
            icon={shown ? Eye : EyeOff}
            size="sm"
            active={!shown}
            onClick={onToggleShown}
          />
          <IconButton label="Close suggestions" icon={X} size="sm" onClick={onClose} />
        </div>
      </div>

      {canDecide && all.length > 1 && (
        <div className="flex gap-2 px-4 pb-3">
          <Button size="sm" icon={Check} onClick={() => onAccept(all)}>
            Accept all
          </Button>
          <Button size="sm" variant="secondary" icon={X} onClick={() => onReject(all)}>
            Reject all
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-rule px-1.5 py-1.5">
        {groups.length === 0 ? (
          <p className="flex gap-2 px-2.5 py-3 text-sm text-graphite">
            <MessageSquarePlus className="size-4 shrink-0" aria-hidden />
            No suggestions right now. People who open the board&apos;s suggest link can propose changes here.
          </p>
        ) : (
          <ul>
            {groups.map((group) => {
              const stale = group.suggestions.some(outdated);
              const last = group.suggestions.at(-1)!; // a group has at least one
              return (
                <li
                  key={group.id}
                  onPointerEnter={() => onHover(group.id)}
                  onPointerLeave={() => onHover(null)}
                  className="rounded-lg px-2.5 py-2 hover:bg-ink/4"
                >
                  <button
                    type="button"
                    className="flex w-full items-start gap-2.5 text-left"
                    onClick={() => {
                      const bounds = groupBounds(group, getElement);
                      if (bounds) onFocus(bounds);
                    }}
                  >
                    <Avatar
                      id={group.author.userId}
                      name={group.author.name}
                      color={group.author.color}
                      src={group.author.avatarUrl}
                      decorative
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {group.author.name}
                        {group.author.guest && <span className="font-normal text-graphite"> (guest)</span>}
                      </span>
                      <span className="block text-sm text-graphite">
                        {summarize(group.suggestions)} · {timeAgo(last.updatedAt)}
                      </span>
                      {stale && (
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-graphite">
                          <TriangleAlert className="size-3.5 text-danger" aria-hidden />
                          Changed on the board since it was suggested
                        </span>
                      )}
                    </span>
                  </button>
                  {canDecide && (
                    <div className="mt-1.5 flex gap-2 pl-[2.375rem]">
                      <Button size="sm" variant="secondary" icon={Check} onClick={() => onAccept(group.suggestions)}>
                        Accept
                      </Button>
                      <Button size="sm" variant="ghost" icon={X} onClick={() => onReject(group.suggestions)}>
                        Reject
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {!canDecide && groups.length > 0 && (
        <p className="border-t border-rule px-4 py-2.5 text-xs text-graphite">
          The board&apos;s owner and editors accept or reject suggestions.
        </p>
      )}
    </aside>
  );
}

/** The ids of the suggestions in the group `groupId`, to draw them standing out. */
export function idsInGroup(groups: SuggestionGroup[], groupId: string | null): ReadonlySet<string> {
  const group = groupId ? groups.find((each) => each.id === groupId) : undefined;
  return new Set(group?.suggestions.map((suggestion) => suggestion.id));
}
