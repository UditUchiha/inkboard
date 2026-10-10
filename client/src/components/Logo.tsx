import clsx from "clsx";
import { APP_NAME } from "../config";

type LogoProps = { className?: string };

export function LogoMark({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 32 32" className={clsx("size-7 shrink-0", className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-[#16213a] dark:fill-marker" />
      <path
        d="M7.5 20.5c2.6-6.4 5-9.6 6.6-9.1 2 .6-1.6 9.3.4 9.8 1.9.5 4.3-7.9 6.4-7.5 1.6.3.4 4.6 3.6 4.4"
        fill="none"
        className="stroke-marker dark:stroke-[#16213a]"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ className }: LogoProps) {
  return (
    <span className={clsx("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span className="text-lg font-extrabold tracking-tight [font-stretch:85%]">{APP_NAME}</span>
    </span>
  );
}
