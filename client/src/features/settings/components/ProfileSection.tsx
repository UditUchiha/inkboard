import clsx from "clsx";
import { Check } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { Avatar } from "../../../components/Avatar";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/Field";
import { api, errorMessage } from "../../../lib/api";
import { PEOPLE_COLORS, colorFor } from "../../../lib/format";
import { formColor } from "../../../lib/profileColor";
import { useAuth } from "../../../providers/AuthProvider";
import type { SignedIn } from "../types/signedIn";
import { SettingsSection } from "./SettingsSection";

export function ProfileSection() {
  const { user, updateUser } = useAuth() as SignedIn;
  const [name, setName] = useState(user.name);
  // null: picked automatically. An old palette color shows as its replacement.
  const [color, setColor] = useState(formColor(user.color));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const automatic = colorFor(user.id);
  const changed = name.trim() !== user.name || color !== user.color;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const { user: updated } = await api.updateProfile({ name, color });
      updateUser(updated);
      setName(updated.name);
      toast.success("Profile saved");
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="Profile" description="Your name and color are shown to people on the boards you open.">
      <form onSubmit={save} className="grid gap-5">
        <div className="flex items-center gap-4">
          <Avatar id={user.id} name={name || user.name} color={color} src={user.avatarUrl} size="lg" />
          <TextField
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            error={error}
            required
            className="flex-1"
          />
        </div>

        <fieldset>
          <legend className="text-sm font-medium">Your color</legend>
          <p className="mt-1 text-sm text-graphite">Used for your cursor and avatar.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[null, ...PEOPLE_COLORS].map((value) => {
              const selected = color === value;
              return (
                <label key={value ?? "auto"} className="cursor-pointer">
                  <input
                    type="radio"
                    name="color"
                    checked={selected}
                    onChange={() => setColor(value)}
                    className="peer sr-only"
                  />
                  <span
                    title={value ? undefined : "Automatic"}
                    className={clsx(
                      "grid size-9 place-items-center rounded-full text-white ring-offset-2 ring-offset-surface transition peer-focus-visible:ring-2 peer-focus-visible:ring-signal",
                      selected ? "ring-2 ring-ink" : "hover:scale-105",
                    )}
                    style={{ backgroundColor: value ?? automatic }}
                  >
                    {value === null ? (
                      <span className="text-xs font-semibold" aria-hidden>
                        A
                      </span>
                    ) : (
                      selected && <Check className="size-4" aria-hidden />
                    )}
                    <span className="sr-only">{value ?? "Automatic"}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div>
          <Button type="submit" loading={saving} disabled={!changed || !name.trim()}>
            Save changes
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}
