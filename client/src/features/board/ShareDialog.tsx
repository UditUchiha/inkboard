import clsx from "clsx";
import { Check, Code, Globe, KeyRound, Link2, Lock, MessageSquarePlus, Pencil, Timer } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";
import { api, errorMessage } from "../../lib/api";
import type { BoardMeta, LinkAccess, Person, Role } from "../../lib/api";
import { embedCode } from "./embed";

// A way the link can open the board, as the dialog offers it.
type LinkOption = { value: LinkAccess; icon: LucideIcon; title: string; detail: string };

const LINK_OPTIONS: LinkOption[] = [
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
    value: "suggest",
    icon: MessageSquarePlus,
    title: "Anyone with the link can suggest",
    detail: "No account needed. What they add, change or delete is a suggestion you and your editors accept or reject.",
  },
  {
    value: "edit",
    icon: Pencil,
    title: "Anyone with the link can edit",
    detail: "No account needed. Guests draw under a name they choose. Only invited people see version history.",
  },
];

const LINK_TOASTS: Record<LinkAccess, string> = {
  restricted: "Only invited people can open the link",
  view: "Anyone with the link can now view",
  suggest: "Anyone with the link can now suggest changes",
  edit: "Anyone with the link can now edit",
};

const DESCRIPTIONS: Record<Role, string> = {
  owner: "Invite people to draw with you, and choose what anyone with the link can do.",
  editor: "People you invite can draw, rename the board and see everyone's cursors.",
  contributor: "The link lets you draw on this board. Only people the owner invites can see who has access.",
  suggester: "The link lets you suggest changes, which the owner and editors accept or reject.",
  viewer: "You can view this board. Only people the owner invites can make changes.",
};

// How long from now the link can be set to work for: null is for good.
const EXPIRY_CHOICES: [label: string, days: number | null][] = [
  ["Never", null],
  ["1 day", 1],
  ["7 days", 7],
  ["30 days", 30],
];

const formatWhen = (date: Date) => date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

type LinkLockSettingsProps = { board: BoardMeta; onBoardChange: (updated: BoardMeta) => void };

/** The owner's settings for a shared link: a password it asks for, when it stops working, and the replay. */
function LinkLockSettings({ board, onBoardChange }: LinkLockSettingsProps) {
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const expiresAt = board.linkExpiresAt ? new Date(board.linkExpiresAt) : null;
  const expired = Boolean(expiresAt && expiresAt.getTime() <= Date.now());

  // Saves a change, and says whether it went through; why not is shown by the password form, or as a toast.
  async function save(lock: Parameters<typeof api.setLinkLock>[1], done: string) {
    setSaving(true);
    setError("");
    try {
      const { board: updated } = await api.setLinkLock(board.id, lock);
      onBoardChange(updated);
      toast.success(done);
      return true;
    } catch (saveError) {
      if ("password" in lock) setError(errorMessage(saveError));
      else toast.error(errorMessage(saveError));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const changing = board.linkPassword;
    if (await save({ password }, changing ? "Password changed. People are asked for the new one." : "Password set")) {
      setEditing(false);
      setPassword("");
    }
  }

  return (
    <div className="mt-4 grid gap-4 rounded-lg border border-rule p-3">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="size-4 text-graphite" aria-hidden /> Password
          </span>
          {!editing && (
            <span className="flex gap-1">
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => setEditing(true)}>
                {board.linkPassword ? "Change" : "Add a password"}
              </Button>
              {board.linkPassword && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  className="text-danger"
                  onClick={() => save({ password: null }, "Password removed")}
                >
                  Remove
                </Button>
              )}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-graphite">
          {board.linkPassword
            ? "People opening the link are asked for it. People you invite never are."
            : "Ask people opening the link for a password you give them."}
        </p>
        {editing && (
          <form onSubmit={submitPassword} className="mt-3 flex items-start gap-2">
            <TextField
              label={board.linkPassword ? "New password" : "Password"}
              hint={board.linkPassword ? "Everyone who came by the link is asked for the new one." : undefined}
              autoComplete="off"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={error}
              required
              className="flex-1"
            />
            <Button type="submit" size="sm" loading={saving} className="mt-[1.6875rem] h-11">
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="mt-[1.6875rem] h-11"
              onClick={() => {
                setEditing(false);
                setPassword("");
                setError("");
              }}
            >
              Cancel
            </Button>
          </form>
        )}
      </div>

      <div>
        <span className="flex items-center gap-2 text-sm font-medium">
          <Timer className="size-4 text-graphite" aria-hidden /> Link expires
        </span>
        <div role="group" aria-label="When the link expires" className="mt-2 flex flex-wrap gap-1.5">
          {EXPIRY_CHOICES.map(([label, days]) => {
            const chosen = days === null && !expiresAt;
            return (
              <button
                key={label}
                type="button"
                aria-pressed={chosen}
                disabled={saving}
                onClick={() =>
                  save(
                    { expiresAt: days === null ? null : new Date(Date.now() + days * 24 * 3600 * 1000).toISOString() },
                    days === null ? "The link no longer expires" : `The link now works for ${label}`,
                  )
                }
                className={clsx(
                  "rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:opacity-60",
                  chosen ? "border-signal bg-signal/5 font-medium" : "border-rule hover:border-graphite/60",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className={clsx("mt-1 text-sm", expired ? "text-danger" : "text-graphite")}>
          {!expiresAt
            ? "The link works until you change who can open it."
            : expired
              ? `Expired ${formatWhen(expiresAt)}. Only people you invite can open the board.`
              : `Stops working ${formatWhen(expiresAt)}. People you invite keep access.`}
        </p>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={board.linkReplay}
          disabled={saving}
          onChange={(event) =>
            save(
              { linkReplay: event.target.checked },
              event.target.checked ? "People with the link can watch the replay" : "Only members can watch the replay",
            )
          }
          className="mt-0.5 size-4 accent-signal"
        />
        <span>
          <span className="font-medium">People with the link can watch the replay</span>
          <span className="block text-graphite">It shows how the board was built, including what was removed.</span>
        </span>
      </label>
    </div>
  );
}

type ShareDialogProps = {
  open: boolean;
  onClose: () => void;
  board: BoardMeta;
  role: Role;
  // Who is looking, or null for a guest.
  currentUser: Person | null;
  // Filled into the invite field when the dialog opens (from a request for access).
  initialEmail?: string;
  onBoardChange: (updated: BoardMeta) => void;
  // Called once the person has left the board.
  onLeft: () => void;
};

export function ShareDialog({
  open,
  onClose,
  board,
  role,
  currentUser,
  initialEmail = "",
  onBoardChange,
  onLeft,
}: ShareDialogProps) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [inviting, setInviting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null); // who Remove / Leave is waiting on a second click for
  const [savingAccess, setSavingAccess] = useState(false);
  const [copied, setCopied] = useState<"link" | "embed" | null>(null); // which copy button just did

  // Start fresh each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setEmail(initialEmail);
    setError("");
    setConfirmingId(null);
  }, [open, initialEmail]);

  const isOwner = role === "owner";
  const isViewer = role !== "owner" && role !== "editor"; // viewers and edit-link contributors
  const linkAccess = board.linkAccess ?? "restricted";
  const members = [{ ...board.owner, role: "Owner" }, ...board.collaborators.map((c) => ({ ...c, role: "Editor" }))];

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setInviting(true);
    try {
      const { board: updated } = await api.inviteCollaborator(board.id, email.trim());
      onBoardChange(updated);
      toast.success(`Invited ${email.trim()}`);
      setEmail("");
    } catch (inviteError) {
      setError(errorMessage(inviteError));
    } finally {
      setInviting(false);
    }
  }

  async function remove(member: Person) {
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
      toast.error(errorMessage(removeError));
    } finally {
      setRemovingId(null);
      setConfirmingId(null);
    }
  }

  async function changeLinkAccess(next: LinkAccess) {
    if (next === linkAccess) return;
    setSavingAccess(true);
    try {
      const { board: updated } = await api.setLinkAccess(board.id, next);
      onBoardChange(updated);
      toast.success(LINK_TOASTS[next]);
    } catch (accessError) {
      toast.error(errorMessage(accessError));
    } finally {
      setSavingAccess(false);
    }
  }

  // Copies `text`, and says which button did for a moment.
  async function copy(text: string, which: "link" | "embed") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error(
        which === "link"
          ? "Couldn't copy the link. Copy it from the address bar instead."
          : "Couldn't copy the embed code.",
      );
    }
  }
  function copyLink() {
    // Without ?thread=, which only makes sense to whoever had that comment open.
    const link = new URL(window.location.href);
    link.searchParams.delete("thread");
    return copy(link.href, "link");
  }

  // The assertion: the link access is one of the options.
  const current = LINK_OPTIONS.find((option) => option.value === linkAccess)!;

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
                  <Avatar id={member.id} name={member.name} color={member.color} src={member.avatarUrl} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {member.name}
                      {isYou && <span className="font-normal text-graphite"> (you)</span>}
                    </p>
                    <p className="truncate text-sm text-graphite">{member.email}</p>
                  </div>
                  {canRemove && confirmingId === member.id ? (
                    <span className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" autoFocus onClick={() => setConfirmingId(null)}>
                        Cancel
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        loading={removingId === member.id}
                        onClick={() => remove(member)}
                        aria-label={isYou ? "Confirm leaving this board" : `Confirm removing ${member.name}`}
                      >
                        {isYou ? "Leave" : "Remove"}
                      </Button>
                    </span>
                  ) : canRemove ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmingId(member.id)}
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
          {linkAccess !== "restricted" && <LinkLockSettings board={board} onBoardChange={onBoardChange} />}
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
        <Button variant="secondary" size="sm" icon={copied === "link" ? Check : Link2} onClick={copyLink}>
          {copied === "link" ? "Copied" : "Copy link"}
        </Button>
      </div>
      {linkAccess !== "restricted" && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2 p-3">
          <p className="text-sm text-graphite">Show the board live on a website. It can only be viewed there.</p>
          <Button
            variant="secondary"
            size="sm"
            icon={copied === "embed" ? Check : Code}
            onClick={() => copy(embedCode(window.location.origin, board), "embed")}
          >
            {copied === "embed" ? "Copied" : "Copy embed code"}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
