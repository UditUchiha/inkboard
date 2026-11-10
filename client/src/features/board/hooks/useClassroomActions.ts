import type { Element as BoardElement, FrameElement } from "@inkboard/shared/types";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getGuest, setGuestName } from "../../../lib/guest";
import { MAX_ELEMENTS_PER_BOARD } from "../constants/board";
import type { ToolId } from "../constants/board";
import { CLAIM_FIRST, CLASSROOM_TOAST, KEEP_INSIDE } from "../constants/editor";
import type { Zone } from "../lib/elements/classroom";
import { frameAt } from "../lib/elements/classroom";
import { copyGroup } from "../lib/elements/connectors";
import { getBounds, isFrame, withContents } from "../lib/elements/elements";
import { fitViewport } from "../lib/elements/geometry";
import type { Size, Viewport, XY } from "../lib/elements/geometry";
import { copyGrid, copyNames } from "../lib/elements/placement";
import type { BoardStore } from "../lib/sync/store";
import type { BoardSync } from "./useBoardSync";

interface ClassroomActionsOptions {
  store: BoardStore;
  sync: BoardSync;
  classroom: BoardSync["classroom"];
  zone: Zone;
  myFrame: FrameElement | null;
  tool: ToolId;
  canvasSize: Size;
  changeViewport: (next: Viewport) => void;
  addDrawing: (drawn: BoardElement[], message: string) => void;
}

export function useClassroomActions({
  store,
  sync,
  classroom,
  zone,
  myFrame,
  tool,
  canvasSize,
  changeViewport,
  addDrawing,
}: ClassroomActionsOptions) {
  const [claiming, setClaiming] = useState<FrameElement | null>(null);
  const [guestVersion, setGuestVersion] = useState(0);

  async function startClassroom() {
    if (!store.getElements().some(isFrame)) {
      toast("Add a frame for each student first: draw one, select it, and use Make copies.");
      return;
    }
    if (await sync.changeClassroom({ action: "start" })) {
      toast("Classroom mode is on. Each student claims an empty frame, and draws only in theirs.");
    }
  }
  const releaseFrame = async (frameId: string) => {
    if (await sync.changeClassroom({ action: "release", frameId })) toast("That frame is free for a student to claim.");
  };

  // Copies of a frame with its contents, one per student, in rows beside the board.
  function copyFrameForClass(frame: FrameElement, count: number) {
    const board = store.getElements();
    const group = withContents(board, frame);
    if (board.length + group.length * count > MAX_ELEMENTS_PER_BOARD) {
      toast.error(`That many copies would be more than a board can hold (${MAX_ELEMENTS_PER_BOARD} elements).`);
      return;
    }
    const names = copyNames(board, frame.name, count);
    // A frame's copy comes first in its group, so it takes the name.
    const copies = copyGrid(board, frame, count).flatMap(([dx, dy], i) =>
      copyGroup(board, group, dx, dy).map((copy, j) => (j === 0 ? { ...copy, name: names[i] } : copy)),
    );
    addDrawing(copies, `Made ${count === 1 ? "a copy" : `${count} copies`} of “${frame.name || "the frame"}”`);
  }

  function goToMyFrame() {
    if (myFrame) changeViewport(fitViewport(getBounds(myFrame), canvasSize, { padding: 48 }));
  }

  async function claimFrame(name: string | null) {
    const frame = claiming;
    if (!frame) return;
    if (name !== null && name !== getGuest().name) {
      sync.socket?.emit("guest:rename", { name: setGuestName(name) });
      setGuestVersion((version) => version + 1);
    }
    const claimed = await sync.changeClassroom({ action: "claim", frameId: frame.id });
    setClaiming(null);
    if (!claimed) {
      toast.error("Someone took that frame just now. Pick another empty one.");
      return;
    }
    toast.success(`“${frame.name || "This frame"}” is yours. Draw away!`);
    changeViewport(fitViewport(getBounds(frame), canvasSize, { padding: 48 }));
  }

  // Offers the pressed frame when the student has none, or says why not. Read through a ref so the canvas isn't redrawn for
  // a new function each render.
  const outsideZone = useRef((_point: XY) => {});
  useLayoutEffect(() => {
    outsideZone.current = (point: XY) => {
      if (tool === "frame") {
        toast("In classroom mode, frames are the teacher's.", { id: CLASSROOM_TOAST });
        return;
      }
      if (zone) {
        if (tool !== "select") toast(KEEP_INSIDE, { id: CLASSROOM_TOAST });
        return;
      }
      const frame = frameAt(store.getElements(), point);
      const claim = frame && classroom?.claims.find((each) => each.frameId === frame.id);
      if (!frame) toast(CLAIM_FIRST, { id: CLASSROOM_TOAST });
      else if (claim) toast(`That frame is ${claim.name}'s. Pick an empty one.`, { id: CLASSROOM_TOAST });
      else setClaiming(frame);
    };
  });
  const pressOutsideZone = useCallback((point: XY) => outsideZone.current(point), []);

  return {
    claiming,
    setClaiming,
    guestVersion,
    startClassroom,
    releaseFrame,
    copyFrameForClass,
    goToMyFrame,
    claimFrame,
    pressOutsideZone,
  };
}
