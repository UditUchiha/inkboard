import type { Element as BoardElement, FrameElement } from "@inkboard/shared/types";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { CLASSROOM_TOAST } from "../constants/editor";
import { fitInside } from "../lib/elements/classroom";
import type { Zone } from "../lib/elements/classroom";
import type { BoardStore } from "../lib/sync/store";
import type { BoardSync } from "./useBoardSync";

interface ClassroomZoneOptions {
  sync: BoardSync;
  store: BoardStore;
  local: boolean;
  elementById: ReadonlyMap<string, BoardElement>;
}

export function useClassroomZone({ sync, store, local, elementById }: ClassroomZoneOptions) {
  const classroom = local ? null : sync.classroom;
  const classroomOn = Boolean(classroom?.on);
  const student = classroomOn && Boolean(classroom?.restricted);
  const myClaim = classroom?.claims.find((claim) => claim.mine && elementById.get(claim.frameId)?.type === "frame");
  // The cast: the claim's frame was just found to be one.
  const myFrame = myClaim ? (elementById.get(myClaim.frameId) as FrameElement) : null;
  const zone: Zone = student ? myFrame : undefined;
  const frameClaims = useMemo(
    () => (classroom?.on ? new Map(classroom.claims.map((claim) => [claim.frameId, claim])) : undefined),
    [classroom],
  );
  // A student's undo history holds where things were; once the teacher moves their frame, going back would put things outside it.
  const zonePlace = zone ? `${zone.id}:${zone.x1},${zone.y1},${zone.x2},${zone.y2}` : "";
  const lastZonePlace = useRef(zonePlace);
  useEffect(() => {
    if (lastZonePlace.current && zonePlace && zonePlace !== lastZonePlace.current) store.forgetHistory();
    lastZonePlace.current = zonePlace;
  }, [zonePlace, store]);

  // Classroom mode: `element` moved as little as puts it inside the student's frame, or null (and they're told).
  function keepInZone<T extends BoardElement>(element: T): T | null {
    if (zone === undefined) return element;
    // The cast: fitInside only moves an element.
    const fitted = zone && (fitInside(element, zone) as T | null);
    if (!fitted) toast("That doesn't fit inside your frame, so it was left out.", { id: CLASSROOM_TOAST });
    return fitted;
  }

  return { classroom, classroomOn, student, myFrame, zone, frameClaims, keepInZone };
}
