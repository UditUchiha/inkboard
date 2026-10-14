import type { Classroom } from "@inkboard/shared/socket";
import type { Element, FrameElement, Plan } from "@inkboard/shared/types";
import { insideZone } from "@inkboard/shared/zones";

// Classroom mode (see docs/classroom-mode.md): while a member has it on, each student (someone the board lets edit
// who isn't a member) claims one empty frame and may change only what lies inside it (see shared/src/zones.ts).
// Members (the teacher) change anything. Frames themselves are the members' alone. Claims are kept when it's turned
// off, so a class picks up where it left off; it's saved with the board.

/** Classroom mode as a board keeps it: whether it's on, and who claimed each frame (their id, and name to show). */
export interface ClassroomState {
  on: boolean;
  claims: Map<string, { by: string; name: string }>;
}

/** Who asks for a change to classroom mode: whether they're a member, or a student, and how to tell a frame. */
export interface ClassroomActor {
  id: string;
  name: string;
  member: boolean;
  student: boolean;
  isFrame: (id: string) => boolean;
}

/** Classroom mode as saved with a board (see sessions.ts), read back; null for anything not written by this server. */
export function readClassroom(saved: unknown): ClassroomState | null {
  const { on, claims } = (saved ?? {}) as { on?: unknown; claims?: unknown };
  if (typeof on !== "boolean" || !Array.isArray(claims)) return null;
  const kept = new Map<string, { by: string; name: string }>();
  for (const claim of claims as { frameId?: unknown; by?: unknown; name?: unknown }[]) {
    if (typeof claim?.frameId === "string" && typeof claim.by === "string" && typeof claim.name === "string") {
      kept.set(claim.frameId, { by: claim.by, name: claim.name });
    }
  }
  return { on, claims: kept };
}

/** Classroom mode as it's saved with a board. */
export const savedClassroom = (state: ClassroomState | null) =>
  state && { on: state.on, claims: [...state.claims].map(([frameId, claim]) => ({ frameId, ...claim })) };

/**
 * Classroom mode after `payload` from `actor`, or undefined when it changes nothing or isn't theirs to do: members
 * start and stop it and free frames; a student claims an empty frame while it's on, when they have none (the frame of a
 * claim that's since been deleted doesn't count).
 */
export function nextClassroom(
  state: ClassroomState | null,
  payload: { action?: unknown; frameId?: unknown } | null | undefined, // as sent: see ClassroomPayload
  actor: ClassroomActor,
): ClassroomState | undefined {
  const frameId = typeof payload?.frameId === "string" ? payload.frameId : null;
  switch (payload?.action) {
    case "start":
      if (!actor.member || state?.on) return undefined;
      return { on: true, claims: state?.claims ?? new Map() };
    case "stop":
      if (!actor.member || !state?.on) return undefined;
      return { on: false, claims: state.claims };
    case "claim": {
      if (!actor.student || !state?.on || !frameId || !actor.isFrame(frameId) || state.claims.has(frameId)) {
        return undefined;
      }
      if ([...state.claims].some(([id, claim]) => claim.by === actor.id && actor.isFrame(id))) return undefined;
      const claims = new Map([...state.claims].filter(([, claim]) => claim.by !== actor.id));
      claims.set(frameId, { by: actor.id, name: actor.name });
      return { on: true, claims };
    }
    case "release": {
      if (!actor.member || !state || !frameId || !state.claims.has(frameId)) return undefined;
      const claims = new Map(state.claims);
      claims.delete(frameId);
      return { on: state.on, claims };
    }
    default:
      return undefined;
  }
}

/** Classroom mode as the person `id` is told it; claims on frames since deleted are left out. */
export function classroomFor(
  state: ClassroomState | null,
  id: string,
  restricted: boolean,
  isFrame: (id: string) => boolean,
): Classroom | null {
  if (!state) return null;
  const claims = [...state.claims]
    .filter(([frameId]) => isFrame(frameId))
    .map(([frameId, claim]) => ({ frameId, name: claim.name, mine: claim.by === id }));
  return { on: state.on, restricted, claims };
}

/**
 * The frame the person `id` may change things in while classroom mode is on and they're a student (`restricted`):
 * undefined when it doesn't restrict them, null when it does and they have no frame.
 */
export function zoneOf(
  state: ClassroomState | null,
  id: string,
  restricted: boolean,
  frameOf: (id: string) => FrameElement | undefined,
): FrameElement | null | undefined {
  if (!restricted || !state?.on) return undefined;
  for (const [frameId, claim] of state.claims) {
    const frame = claim.by === id ? frameOf(frameId) : undefined;
    if (frame) return frame;
  }
  return null;
}

/**
 * What a planned change from a student would do outside their frame (`zone`; none at all when null): the ids of
 * elements it would add, change or bring back that aren't inside it before and after, and of those it would remove that
 * weren't inside it. `before` is an element as it was, on the board or among what was removed.
 */
export function outsideZone(
  plan: Pick<Plan, "shown" | "buried" | "hidden">,
  before: (id: string) => Element | undefined,
  zone: FrameElement | null,
): { upsert: string[]; remove: string[] } {
  const inside = (element: Element | undefined) => zone !== null && element !== undefined && insideZone(element, zone);
  const upsert = [...plan.shown, ...plan.buried]
    .filter(([id, after]) => !inside(after) || (before(id) !== undefined && !inside(before(id))))
    .map(([id]) => id);
  const remove = [...plan.hidden.keys()].filter((id) => !inside(before(id)));
  return { upsert, remove };
}
