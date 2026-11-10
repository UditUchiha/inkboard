import clsx from "clsx";
import { KeyRound, Timer } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/Field";
import { api, errorMessage } from "../../../lib/api";
import type { BoardMeta } from "../../../lib/api";

const EXPIRY_CHOICES: [label: string, days: number | null][] = [
  ["Never", null],
  ["1 day", 1],
  ["7 days", 7],
  ["30 days", 30],
];

const formatWhen = (date: Date) => date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

type LinkLockSettingsProps = { board: BoardMeta; onBoardChange: (updated: BoardMeta) => void };

export function LinkLockSettings({ board, onBoardChange }: LinkLockSettingsProps) {
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const expiresAt = board.linkExpiresAt ? new Date(board.linkExpiresAt) : null;
  const expired = Boolean(expiresAt && expiresAt.getTime() <= Date.now());

  // The password form or a toast shows why a save didn't go through.
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
