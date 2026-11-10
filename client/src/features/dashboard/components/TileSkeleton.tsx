export function TileSkeleton() {
  return (
    <li aria-hidden>
      <div className="aspect-[16/10] animate-pulse rounded-lg bg-ink/6" />
      <div className="mt-3 h-4 w-2/3 animate-pulse rounded bg-ink/6" />
      <div className="mt-2 h-3.5 w-1/3 animate-pulse rounded bg-ink/6" />
    </li>
  );
}
