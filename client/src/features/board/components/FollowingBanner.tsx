import { X } from "lucide-react";

export interface FollowingBannerProps {
  name: string;
  onStop: () => void;
}

export function FollowingBanner({ name, onStop }: FollowingBannerProps) {
  return (
    <div className="absolute top-[4.25rem] left-1/2 -translate-x-1/2 max-md:top-16">
      <button
        type="button"
        onClick={onStop}
        className="floating-panel flex h-9 items-center gap-2 rounded-full pr-2 pl-4 text-sm transition-colors hover:bg-surface-2"
      >
        Following <strong className="font-semibold">{name}</strong>
        <span className="grid size-5 place-items-center rounded-full bg-ink/8" aria-hidden>
          <X className="size-3" />
        </span>
        <span className="sr-only">Stop following</span>
      </button>
    </div>
  );
}
