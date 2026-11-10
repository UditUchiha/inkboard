import { useMemo } from "react";
import type { BoardSync, Peer } from "./useBoardSync";

export function useOtherPeople(sync: BoardSync, selfId: string) {
  return useMemo(() => {
    const seen = new Map<string, Peer>();
    for (const peer of sync.peers) {
      if (peer.userId !== selfId && !seen.has(peer.userId)) seen.set(peer.userId, peer);
    }
    return [...seen.values()];
  }, [sync.peers, selfId]);
}
