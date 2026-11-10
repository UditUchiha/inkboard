import { RemoteCursorArrow } from "../../board/components/RemoteCursors";
import type { Person } from "../lib/showcase";

interface SceneCursorProps {
  person: Person;
  x: number;
  y: number;
  scale: number;
  glide?: boolean;
}

// A collaborator's cursor over a sample board, in scene coordinates.
export function SceneCursor({ person, x, y, scale, glide = false }: SceneCursorProps) {
  return (
    <div
      className={glide ? "absolute top-0 left-0 transition-transform duration-700 ease-out" : "absolute top-0 left-0"}
      style={{ transform: `translate(${x * scale}px, ${y * scale}px)` }}
    >
      <RemoteCursorArrow color={person.color} />
      <span
        className="absolute top-5 left-3.5 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-white"
        style={{ backgroundColor: person.color }}
      >
        {person.name}
      </span>
    </div>
  );
}
