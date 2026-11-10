import type { Element as BoardElement } from "@inkboard/shared/types";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { Style } from "../constants/board";
import { CLAIM_FIRST, CLASSROOM_TOAST, KEEP_INSIDE } from "../constants/editor";
import { canChange, staysInside } from "../lib/elements/classroom";
import type { Zone } from "../lib/elements/classroom";
import { canConnectTo, connectArrow, connectTargets } from "../lib/elements/connectors";
import type { BoardStore } from "../lib/sync/store";

interface ConnectOptions {
  store: BoardStore;
  elements: BoardElement[];
  selected: BoardElement | null;
  selectedId: string | null;
  zone: Zone;
  style: Style;
  selectElement: (id: string) => void;
}

export function useConnectFromKeyboard({
  store,
  elements,
  selected,
  selectedId,
  zone,
  style,
  selectElement,
}: ConnectOptions) {
  // K with a shape selected offers the shapes an arrow could go to, nearest first; Enter draws it (see connectTargets).
  const [connecting, setConnecting] = useState<{ fromId: string; targetId?: string } | null>(null);
  const [connectingFor, setConnectingFor] = useState(selectedId);
  if (selectedId !== connectingFor) {
    setConnectingFor(selectedId);
    setConnecting(null);
  }
  const connectFrom = connecting?.fromId === selectedId ? selected : null;
  const connectOptions = useMemo(
    () => (connectFrom ? connectTargets(elements, connectFrom).filter((target) => canChange(target, zone)) : []),
    [connectFrom, elements, zone],
  );
  const connectIndex = Math.max(
    0,
    connectOptions.findIndex((target) => target.id === connecting?.targetId),
  );
  const connectTo = connectOptions.at(connectIndex) ?? null;

  function startConnect() {
    if (!selected) {
      toast("Select a shape first, then press K to connect it to another.");
      return;
    }
    if (!canChange(selected, zone)) {
      toast(zone ? KEEP_INSIDE : CLAIM_FIRST, { id: CLASSROOM_TOAST });
      return;
    }
    if (!canConnectTo(selected)) {
      toast("Arrows connect shapes, notes, pictures and text. Select one of those, then press K.");
      return;
    }
    if (!connectTargets(store.getElements(), selected).some((target) => canChange(target, zone))) {
      toast(zone ? "There's nothing else in your frame to connect it to." : "There's nothing else to connect it to.");
      return;
    }
    setConnecting({ fromId: selected.id });
  }

  function stepConnect(by: number) {
    if (!connecting || !connectTo) return;
    const count = connectOptions.length;
    setConnecting({ ...connecting, targetId: connectOptions[(connectIndex + by + count) % count].id });
  }

  // Drawn as a drag between the shapes would be: one undo step, then selected, so Enter gives it a label.
  function finishConnect() {
    if (!connectFrom || !connectTo) return;
    const arrow = connectArrow(connectFrom, connectTo, style);
    if (!staysInside(arrow, zone)) {
      toast(KEEP_INSIDE, { id: CLASSROOM_TOAST });
      return;
    }
    store.commit({ undo: { remove: [arrow.id] }, redo: { upsert: [arrow] } });
    selectElement(arrow.id);
  }

  return {
    connectTo,
    connectIndex,
    connectOptions,
    startConnect,
    stepConnect,
    finishConnect,
    cancelConnect: () => setConnecting(null),
  };
}
