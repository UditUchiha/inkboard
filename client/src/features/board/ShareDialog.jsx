import clsx from "clsx";
import { Check, Globe, Link2, Lock, Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";
import { api } from "../../lib/api";

const LINK_OPTIONS = [
  {
    value: "restricted",
    icon: Lock,
    title: "Restricted",
    detail: "Only people you invite can open the link.",
  },
  {
    value: "view",
    icon: Globe,
    title: "Anyone with the link can view",
    detail: "No account needed. Only invited people can edit.",
  },
  {
    value: "edit",
    icon: Pencil,
    title: "Anyone with the link can edit",
    detail: "No account needed. Guests draw under a name they choose. Only invited people see version history.",
  },
];

const LINK_TOASTS = {
  restricted: "Only invited people can open the link",
  view: "Anyone with the link can now view",
  edit: "Anyone with the link can now edit",
};

const DESCRIPTIONS = {
  owner: "Invite people to draw with you, and choose what anyone with the link can do.",
  editor: "People you invite can draw, rename the board and see everyone's cursors.",
  contributor: "The link lets you draw on this board. Only people the owner invites can see who has access.",
  viewer: "You can view this board. Only people the owner invites can make changes.",
};

export function ShareDialog({ open, onClose, board, role, currentUser, onBoardChange, onLeft }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [inviting, setInviting] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [savingAccess, setSavingAccess] = useState(false);
  const [copied, setCopied] = useState(false);

  const isOwner = role === "owner";
  const isViewer = role !== "owner" && role !== "editor"; // viewers and edit-link contributors
  const linkAccess = board.linkAccess ?? "restricted";
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
    const leaving = member.id === currentUser?.id;
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

  async function changeLinkAccess(next) {
    if (next === linkAccess) return;
    setSavingAccess(true);
    try {
      const { board: updated } = await api.setLinkAccess(board.id, next);
      onBoardChange(updated);
      toast.success(LINK_TOASTS[next]);
    } catch (accessError) {
      toast.error(accessError.message);
    } finally {
      setSavingAccess(false);
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

  const current = LINK_OPTIONS.find((option) => option.value === linkAccess);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share this board"
      description={DESCRIPTIONS[role] ?? DESCRIPTIONS.viewer}
    >
      {isOwner && (
        <form onSubmit={invite} className="flex items-start gap-2">
          <TextField
            label="Invite to edit"
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

      {!isViewer && (
        <div className={isOwner ? "mt-6" : ""}>
          <h3 className="text-sm font-medium text-graphite">People with access</h3>
          <ul className="mt-2 divide-y divide-rule">
            {members.map((member) => {
              const isYou = member.id === currentUser?.id;
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
      )}

      {isOwner ? (
        <fieldset disabled={savingAccess} className="mt-6">
          <legend className="text-sm font-medium text-graphite">Who can open the link</legend>
          <div className="mt-2 grid gap-2">
            {LINK_OPTIONS.map(({ value, icon: Icon, title, detail }) => (
              <label
                key={value}
                className={clsx(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-focus-visible:ring-3 has-focus-visible:ring-signal/20 has-disabled:cursor-wait has-disabled:opacity-70",
                  linkAccess === value ? "border-signal bg-signal/5" : "border-rule hover:border-graphite/60",
                )}
              >
                <input
                  type="radio"
                  name="link-access"
                  value={value}
                  checked={linkAccess === value}
                  onChange={() => changeLinkAccess(value)}
                  className="sr-only"
                />
                <Icon className="mt-0.5 size-4 shrink-0 text-graphite" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-sm text-graphite">{detail}</span>
                </span>
                {linkAccess === value && <Check className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        !isViewer && (
          <p className="mt-5 flex items-center gap-2 text-sm text-graphite">
            <current.icon className="size-4 shrink-0" aria-hidden />
            {current.title}: {current.detail}
          </p>
        )
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2 p-3">
        <p className="text-sm text-graphite">
          {isViewer ? "Share this link with others who should see the board." : "Copy the link to share the board."}
        </p>
        <Button variant="secondary" size="sm" icon={copied ? Check : Link2} onClick={copyLink}>
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </Dialog>
  );
}
