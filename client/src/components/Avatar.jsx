import clsx from "clsx";
import { colorFor, initials } from "../lib/format";

const SIZES = {
  xs: "size-6 text-[10px]",
  sm: "size-8 text-xs",
  md: "size-9 text-sm",
};

export function Avatar({ id, name, size = "sm", className, title }) {
  return (
    <span
      title={title ?? name}
      className={clsx(
        "inline-grid shrink-0 place-items-center rounded-full font-semibold text-white ring-2 ring-surface select-none",
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: colorFor(id) }}
    >
      {initials(name)}
      <span className="sr-only">{name}</span>
    </span>
  );
}

export function AvatarStack({ people, size = "sm", max = 4 }) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((person) => (
        <Avatar key={person.key ?? person.id} id={person.id} name={person.name} size={size} title={person.title} />
      ))}
      {extra > 0 && (
        <span
          className={clsx(
            "inline-grid place-items-center rounded-full bg-surface-2 font-semibold text-graphite ring-2 ring-surface",
            SIZES[size],
          )}
          title={`${extra} more`}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}
