import type { CursorPayload } from "@inkboard/shared/socket";
import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { AppSocket } from "../../../providers/SocketProvider";
import type { XY } from "../lib/elements/geometry";

const CURSOR_INTERVAL_MS = 50;

export function useCursorSending(socket: AppSocket | null, joined: RefObject<boolean>) {
  // Throttled, but the last position is always sent, so a pointer that came to rest shows where it stopped.
  const lastCursorAt = useRef(0);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCursor = useRef<CursorPayload>({});
  useEffect(() => () => clearTimeout(cursorTimer.current as ReturnType<typeof setTimeout> | undefined), []);
  return useCallback(
    (point: XY | null, laser = false) => {
      if (!socket || !joined.current) return;
      const emit = (payload: CursorPayload) => {
        lastCursorAt.current = performance.now();
        socket.volatile.emit("cursor", payload);
      };
      latestCursor.current = point ? { ...point, ...(laser && { laser }) } : {};
      const wait = CURSOR_INTERVAL_MS - (performance.now() - lastCursorAt.current);
      if (!point || wait <= 0) {
        clearTimeout(cursorTimer.current as ReturnType<typeof setTimeout> | undefined);
        cursorTimer.current = null;
        emit(latestCursor.current);
      } else {
        cursorTimer.current ??= setTimeout(() => {
          cursorTimer.current = null;
          if (joined.current) emit(latestCursor.current);
        }, wait);
      }
    },
    [socket, joined],
  );
}
