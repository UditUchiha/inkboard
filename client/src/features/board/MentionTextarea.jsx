import clsx from "clsx";
import { useRef, useState } from "react";
import { Avatar } from "../../components/Avatar";

const MENTION_AT_CARET = /(^|\s)@(\S*)$/;

/** The ids of picked people whose "@Name" is still in the text. */
export const activeMentions = (text, members, ids) =>
  ids.filter((id) => {
    const member = members.find((m) => m.id === id);
    return member && text.includes(`@${member.name}`);
  });

/**
 * A comment box where typing "@" suggests people on the board. `onChange`
 * gets the text and the ids of everyone mentioned so far. Enter sends,
 * Shift+Enter adds a line.
 */
export function MentionTextarea({ text, mentions, onChange, onSubmit, members, placeholder, autoFocus, label }) {
  const ref = useRef(null);
  const [query, setQuery] = useState(null); // the text after "@", or null when not mentioning
  const [highlight, setHighlight] = useState(0);

  const suggestions =
    query === null
      ? []
      : members.filter((member) => member.name.toLowerCase().includes(query.toLowerCase())).slice(0, 5);

  function handleChange(event) {
    const next = event.target.value;
    const before = next.slice(0, event.target.selectionStart);
    const match = MENTION_AT_CARET.exec(before);
    setQuery(match ? match[2] : null);
    setHighlight(0);
    onChange(next, activeMentions(next, members, mentions));
  }

  function pick(member) {
    const textarea = ref.current;
    const caret = textarea.selectionStart;
    const before = text.slice(0, caret).replace(MENTION_AT_CARET, (_, space) => `${space}@${member.name} `);
    const next = before + text.slice(caret);
    setQuery(null);
    onChange(next, [...new Set([...activeMentions(next, members, mentions), member.id])]);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(before.length, before.length);
    });
  }

  function handleKeyDown(event) {
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
        autoFocus={autoFocus}
        rows={2}
        maxLength={2000}
        className="block w-full resize-none rounded-lg border border-rule bg-surface px-3 py-2 text-sm placeholder:text-graphite/70 focus:border-signal focus:ring-3 focus:ring-signal/20 focus:outline-none"
      />
      {suggestions.length > 0 && (
        <ul role="listbox" className="floating-panel absolute right-0 bottom-full left-0 z-10 mb-1 rounded-lg p-1">
          {suggestions.map((member, index) => (
            <li key={member.id} role="option" aria-selected={index === highlight}>
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
