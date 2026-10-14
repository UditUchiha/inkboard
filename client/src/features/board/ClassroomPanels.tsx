import type { FrameElement } from "@inkboard/shared/types";
import { GraduationCap } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";

// Classroom mode's controls (see classroom.ts and docs/classroom-mode.md).

/** The most copies of a frame made at once: a class, with room to spare. */
export const MAX_FRAME_COPIES = 60;

/**
 * What the classroom notice takes: for the teacher, how many frames are claimed and how to end it; for a student, the
 * name of their frame (null before they have one) and how to go to it.
 */
export type ClassroomNoticeProps =
  | { teacher: true; claimed: number; frames: number; onEnd: () => void }
  | { teacher: false; frameName: string | null; onGoTo: () => void };

/** Under the toolbar while classroom mode is on: how it's going, for the teacher; what to do, for a student. */
export function ClassroomNotice(props: ClassroomNoticeProps) {
  const action = "font-medium text-signal underline-offset-2 hover:underline";
  let detail;
  if (props.teacher) {
    detail = (
      <>
        <span className="text-graphite">
          {props.claimed} of {props.frames} {props.frames === 1 ? "frame" : "frames"} claimed
        </span>
        <button type="button" onClick={props.onEnd} className={action}>
          End
        </button>
      </>
    );
  } else if (props.frameName === null) {
    detail = <span className="text-graphite">Click an empty frame to make it yours</span>;
  } else {
    detail = (
      <>
        <span className="truncate text-graphite">Your frame: {props.frameName}</span>
        <button type="button" onClick={props.onGoTo} className={`shrink-0 ${action}`}>
          Go to it
        </button>
      </>
    );
  }
  return (
    <div role="status" className="floating-panel flex h-8 max-w-full items-center gap-2 rounded-full px-3 text-xs">
      <GraduationCap className="size-3.5 shrink-0 text-signal" aria-hidden />
      <span className="shrink-0 font-medium">Classroom mode</span>
      {detail}
    </div>
  );
}

/**
 * What the claim dialog takes: the frame a student pressed on (null when closed), their name as a guest (null when
 * signed in, whose name is their account's), and what to do with the name they chose.
 */
export type ClaimFrameDialogProps = {
  frame: FrameElement | null;
  guestName: string | null;
  onClaim: (name: string | null) => Promise<void>;
  onClose: () => void;
};

/** Asks a student whether to make the frame they pressed on theirs, and, as a guest, what to call them on it. */
export function ClaimFrameDialog({ frame, guestName, onClaim, onClose }: ClaimFrameDialogProps) {
  const [name, setName] = useState(guestName ?? "");
  const [claiming, setClaiming] = useState(false);
  useEffect(() => setName(guestName ?? ""), [frame, guestName]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setClaiming(true);
    await onClaim(guestName === null ? null : name.trim());
    setClaiming(false);
  }

  return (
    <Dialog
      open={Boolean(frame)}
      onClose={onClose}
      title={`Make “${frame?.name || "this frame"}” yours?`}
      description="Only you and your teacher can draw in it. To move to another frame later, ask your teacher."
    >
      <form onSubmit={submit} className="grid gap-5">
        {guestName !== null && (
          <TextField
            label="Your name, shown on your frame"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            autoFocus
            required
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={claiming} disabled={guestName !== null && !name.trim()}>
            Make it mine
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** What a frame's classroom section takes: who claimed it (if anyone), and how to free it or copy it for a class. */
export type FrameClassroomProps = {
  claimedBy: string | null;
  onRelease: () => void;
  onCopy: (count: number) => void;
};

/**
 * In a selected frame's panel, for the teacher: who claimed it, with a way to free it (for a student on another
 * device, say), and copies of it, contents and all, one for each student.
 */
export function FrameClassroom({ claimedBy, onRelease, onCopy }: FrameClassroomProps) {
  const [count, setCount] = useState("10");
  const copies = Math.floor(Number(count));
  const valid = copies >= 1 && copies <= MAX_FRAME_COPIES;
  return (
    <div className="grid gap-2 border-t border-rule pt-3">
      <p className="text-xs font-medium text-graphite">For a class</p>
      {claimedBy && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate">
            Claimed by <span className="font-medium">{claimedBy}</span>
          </span>
          <button type="button" onClick={onRelease} className="shrink-0 font-medium text-signal hover:underline">
            Free it
          </button>
        </div>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onCopy(copies);
        }}
      >
        <input
          type="number"
          min={1}
          max={MAX_FRAME_COPIES}
          value={count}
          onChange={(event) => setCount(event.target.value)}
          aria-label="How many copies"
          className="h-8 w-16 rounded-lg border border-rule bg-surface px-2 text-xs"
        />
        <button
          type="submit"
          disabled={!valid}
          className="flex h-8 flex-1 items-center justify-center rounded-lg border border-rule text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
        >
          Make copies
        </button>
      </form>
    </div>
  );
}
