import clsx from "clsx";
import { useId, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { Avatar } from "../../components/Avatar";
import type { Person } from "../../lib/api";
import { activeMentions, isComposing, MENTION_AT_CARET } from "./mentions";

type MentionTextareaProps = {
  text: string;
  // The ids of the people mentioned so far.
  mentions: string[];
  onChange: (text: string, mentions: string[]) => void;
  onSubmit: () => void;
  // The people who can be mentioned.
  members: Person[];
  placeholder: string;
  autoFocus?: boolean;
  label: string;
};

/**
 * A comment box where typing "@" suggests people on the board. `onChange`
 * gets the text and the ids of everyone mentioned so far. Enter sends,
 * Shift+Enter adds a line.
 */
export function MentionTextarea({
  text,
  mentions,
  onChange,
  onSubmit,
  members,
  placeholder,
  autoFocus,
  label,
}: MentionTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null); // the text after "@", or null when not mentioning
  const [highlight, setHighlight] = useState(0);

  const suggestions =
    query === null
      ? []
      : members.filter((member) => member.name.toLowerCase().includes(query.toLowerCase())).slice(0, 5);

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const next = event.target.value;
    const before = next.slice(0, event.target.selectionStart);
    const match = MENTION_AT_CARET.exec(before);
    setQuery(match ? match[2] : null);
    setHighlight(0);
    onChange(next, activeMentions(next, members, mentions));
  }

  function pick(member: Person) {
    // The assertion: a suggestion is only shown, and picked, while the textarea is on the page.
    const textarea = ref.current!;
    const caret = textarea.selectionStart;
    const before = text
      .slice(0, caret)
      .replace(MENTION_AT_CARET, (_: string, space: string) => `${space}@${member.name} `);
    const next = before + text.slice(caret);
    setQuery(null);
    onChange(next, [...new Set([...activeMentions(next, members, mentions), member.id])]);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(before.length, before.length);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isComposing(event)) return; // Enter confirms the composition, it doesn't send or pick
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((current) => (current + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(suggestions[highlight]);
        return;
      }
      if (event.key === "Escape") {
        event.stopPropagation();
        setQuery(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={label}
        aria-controls={suggestions.length > 0 ? listId : undefined}
        aria-activedescendant={suggestions.length > 0 ? `${listId}-${highlight}` : undefined}
        autoFocus={autoFocus}
        rows={2}
        maxLength={2000}
        className="block w-full resize-none rounded-lg border border-rule bg-surface px-3 py-2 text-sm placeholder:text-graphite/70 focus:border-signal focus:ring-3 focus:ring-signal/20 focus:outline-none"
      />
      {suggestions.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="People to mention"
          className="floating-panel absolute right-0 bottom-full left-0 z-10 mb-1 rounded-lg p-1"
        >
          {suggestions.map((member, index) => (
            <li key={member.id} id={`${listId}-${index}`} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault(); // keep focus in the textarea
                  pick(member);
                }}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  index === highlight ? "bg-signal/10" : "hover:bg-ink/6",
                )}
              >
                <Avatar
                  id={member.id}
                  name={member.name}
                  color={member.color}
                  src={member.avatarUrl}
                  size="xs"
                  decorative
                />
                <span className="truncate">{member.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
