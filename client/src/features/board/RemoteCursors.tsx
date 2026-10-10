import { personColor } from "../../lib/format";
import { useCursors } from "./cursors";
import type { CursorStore } from "./cursors";
import { toScreen } from "./geometry";
import type { Viewport } from "./geometry";
import type { Peer } from "./useBoardSync";

type RemoteCursorsProps = { cursors: CursorStore; peers: Peer[]; viewport: Viewport };

// `cursors` is a cursor store (see cursors.js).
export function RemoteCursors({ cursors: store, peers, viewport }: RemoteCursorsProps) {
  const cursors = useCursors(store);
  const bySocket = new Map(peers.map((peer) => [peer.socketId, peer]));

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {Object.entries(cursors).map(([socketId, point]) => {
        const peer = bySocket.get(socketId);
        if (!peer) return null;
        const { x, y } = toScreen(viewport, point.x, point.y);
        const color = personColor(peer);
        return (
          <div
            key={socketId}
            className="absolute top-0 left-0 transition-transform duration-75 ease-linear"
            style={{ transform: `translate(${x}px, ${y}px)` }}
          >
            <RemoteCursorArrow color={color} />
            <span
              className="absolute top-5 left-3.5 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-white"
              style={{ backgroundColor: color }}
            >
              {peer.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function RemoteCursorArrow({ color }: { color: string }) {
  return (
    <svg width="18" height="20" viewBox="0 0 18 20" className="drop-shadow-sm">
      <path d="M1.5 1.5 16 9.2l-6.4 1.6-3 6.6z" fill={color} stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
