import { useState } from "react";
import { useLocation } from "react-router";
import { Avatar } from "../../components/Avatar";
import { Button, ButtonLink } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";
import { getGuest, setGuestName } from "../../lib/guest";

/** A signed-out visitor's name on a shared board, with a nudge to make an account. */
export function GuestIdentity({ socket }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [guest, setGuest] = useState(getGuest);
  const [name, setName] = useState(guest.name);

  const next = encodeURIComponent(location.pathname + location.search);

  function save(event) {
    event.preventDefault();
    const clean = setGuestName(name);
    setGuest(getGuest());
    setName(clean);
    socket?.emit("guest:rename", { name: clean });
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Change your name"
        className="floating-panel flex h-10 max-w-44 items-center gap-2 rounded-xl pr-3 pl-1.5 text-sm transition-colors hover:bg-surface-2"
      >
        <Avatar id={guest.id} name={guest.name} size="xs" decorative />
        <span className="truncate max-sm:sr-only">{guest.name}</span>
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="You're a guest"
        description="Other people see this name next to your cursor. Make an account to keep your own boards."
      >
        <form onSubmit={save} className="grid gap-5">
          <TextField
            label="Your name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            autoFocus
            required
          />
          <div className="flex flex-wrap justify-between gap-2">
            <ButtonLink to={`/register?next=${next}`} variant="secondary">
              Create an account
            </ButtonLink>
            <Button type="submit" disabled={!name.trim()}>
              Save name
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
