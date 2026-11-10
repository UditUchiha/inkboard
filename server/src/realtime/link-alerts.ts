import type { Element } from "@inkboard/shared/types";
import { warnOwner } from "../services/notifications.ts";
import { recordVersion } from "../services/versions.ts";
import { emptyLinkWatch, LINK_VISITORS_WARNING, MASS_REMOVAL, noteRemovals } from "./link-watch.ts";
import type { LinkWatch } from "./link-watch.ts";
import type { Session } from "./sessions.ts";

// Tells a board's owner when people on its edit link join in numbers or remove much of the board (see link-watch.ts).

const linkWatches = new WeakMap<Session, LinkWatch>();
export function watchOf(session: Session) {
  let watch = linkWatches.get(session);
  if (!watch) linkWatches.set(session, (watch = emptyLinkWatch()));
  return watch;
}

export const VISITORS_WARNING = `${LINK_VISITORS_WARNING} people who weren't invited have opened it with its edit link. If you didn't share the link that widely, restrict it in Share.`;
const REMOVAL_LABEL = "Before the edit-link removals"; // short enough to read whole in version history

// Much removal by people on the link (see noteRemovals) saves the earlier board in version history and warns the owner.
export function watchRemovals(session: Session, count: number, before: Element[]) {
  const earlier = noteRemovals(watchOf(session), count, before);
  if (!earlier) return;
  const what = `${MASS_REMOVAL} or more elements were removed by people using its edit link.`;
  recordVersion(session.boardId, earlier, { kind: "auto", label: REMOVAL_LABEL })
    .then((version) =>
      warnOwner(
        session.boardId,
        "removals",
        version
          ? `${what} A copy from before is in version history.`
          : `${what} Version history had no room for a copy from before.`,
      ),
    )
    .catch((error: Error) => console.error(`Could not keep board ${session.boardId} from before: ${error.message}`));
}
