import { Check, Link2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";
import { api } from "../../lib/api";

export function ShareDialog({ open, onClose, board, currentUser, onBoardChange, onLeft }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [inviting, setInviting] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [copied, setCopied] = useState(false);

  const isOwner = board.owner.id === currentUser.id;
  const members = [{ ...board.owner, role: "Owner" }, ...board.collaborators.map((c) => ({ ...c, role: "Editor" }))];

  async function invite(event) {
    event.preventDefault();
    setError("");
    setInviting(true);
    try {
      const { board: updated } = await api.inviteCollaborator(board.id, email.trim());
      onBoardChange(updated);
      toast.success(`Invited ${email.trim()}`);
      setEmail("");
    } catch (inviteError) {
      setError(inviteError.message);
    } finally {
      setInviting(false);
    }
  }

  async function remove(member) {
    const leaving = member.id === currentUser.id;
    setRemovingId(member.id);
    try {
      const { board: updated } = await api.removeCollaborator(board.id, leaving ? "me" : member.id);
      if (leaving) {
        onLeft();
        return;
      }
      onBoardChange(updated);
      toast.success(`Removed ${member.name}`);
    } catch (removeError) {
      toast.error(removeError.message);
    } finally {
      setRemovingId(null);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy the link. Copy it from the address bar instead.");
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share this board"
      description="People you invite can draw, rename the board and see everyone's cursors."
    >
      {isOwner && (
        <form onSubmit={invite} className="flex items-start gap-2">
          <TextField
            label="Invite by email"
            type="email"
            placeholder="teammate@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={error}
            required
            className="flex-1"
          />
          <Button type="submit" loading={inviting} className="mt-[1.6875rem] h-11">
            Invite
          </Button>
        </form>
      )}

      <div className={isOwner ? "mt-6" : ""}>
        <h3 className="text-sm font-medium text-graphite">People with access</h3>
        <ul className="mt-2 divide-y divide-rule">
          {members.map((member) => {
            const isYou = member.id === currentUser.id;
            const canRemove = member.role !== "Owner" && (isOwner || isYou);
            return (
              <li key={member.id} className="flex items-center gap-3 py-2.5">
                <Avatar id={member.id} name={member.name} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {member.name}
                    {isYou && <span className="font-normal text-graphite"> (you)</span>}
                  </p>
                  <p className="truncate text-sm text-graphite">{member.email}</p>
                </div>
                {canRemove ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={removingId === member.id}
                    onClick={() => remove(member)}
                    className="text-danger"
                  >
                    {isYou ? "Leave" : "Remove"}
                  </Button>
                ) : (
                  <span className="text-sm text-graphite">{member.role}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2 p-3">
        <p className="text-sm text-graphite">Only people with access can open the link.</p>
        <Button variant="secondary" size="sm" icon={copied ? Check : Link2} onClick={copyLink}>
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </Dialog>
  );
}
