import clsx from "clsx";
import { useState } from "react";
import { colorFor, initials } from "../lib/format";

const SIZES = {
  xs: "size-6 text-[10px]",
  sm: "size-8 text-xs",
  md: "size-9 text-sm",
  lg: "size-14 text-lg",
};

/** A person's photo (from Google or GitHub) or their initials on their color. */
// Pass `decorative` when the person's name is already shown next to the avatar.
export function Avatar({ id, name, color, src, size = "sm", className, title, decorative = false }) {
  const [broken, setBroken] = useState(false);
  const showPhoto = src && !broken;

  return (
    <span
      title={title ?? name}
      aria-hidden={decorative || undefined}
      className={clsx(
        "inline-grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-white ring-2 ring-surface select-none",
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: color || colorFor(id) }}
    >
      {showPhoto ? (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        initials(name)
      )}
      {!decorative && <span className="sr-only">{name}</span>}
    </span>
  );
}

export function AvatarStack({ people, size = "sm", max = 4 }) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((person) => (
        <Avatar
          key={person.key ?? person.id}
          id={person.id}
          name={person.name}
          color={person.color}
          src={person.avatarUrl}
          size={size}
          title={person.title}
        />
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
