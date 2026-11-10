import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "../../../components/Button";
import { PasswordField } from "../../../components/Field";
import { api, errorMessage } from "../../../lib/api";
import { useAuth } from "../../../providers/AuthProvider";
import type { SignedIn } from "../types/signedIn";
import { SettingsSection } from "./SettingsSection";

type PasswordProblem = { field: "currentPassword" | "newPassword"; message: string };

export function PasswordSection() {
  const { user, startSession } = useAuth() as SignedIn;
  const [form, setForm] = useState({ currentPassword: "", newPassword: "" });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<PasswordProblem | null>(null);

  const update = (field: keyof typeof form) => (event: ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    if (form.newPassword.length < 8) {
      setProblem({ field: "newPassword", message: "Use at least 8 characters for the new password." });
      return;
    }
    setSaving(true);
    try {
      // Every other login ends when the password changes; the reply holds a new login for this one.
      startSession(await api.changePassword(form));
      setForm({ currentPassword: "", newPassword: "" });
      toast.success(user.hasPassword ? "Password changed" : "Password set");
    } catch (saveError) {
      const aboutCurrent = /current password/i.test(errorMessage(saveError));
      setProblem({
        field: aboutCurrent ? "currentPassword" : "newPassword",
        message: errorMessage(saveError),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      title={user.hasPassword ? "Password" : "Set a password"}
      description={
        user.hasPassword
          ? "Use at least 8 characters."
          : "You sign in with Google or GitHub. Add a password to log in with your email as well."
      }
    >
      <form onSubmit={save} className="grid max-w-sm gap-4" noValidate>
        {user.hasPassword && (
          <PasswordField
            label="Current password"
            autoComplete="current-password"
            value={form.currentPassword}
            onChange={update("currentPassword")}
            error={problem?.field === "currentPassword" ? problem.message : undefined}
            required
          />
        )}
        <PasswordField
          label="New password"
          autoComplete="new-password"
          value={form.newPassword}
          onChange={update("newPassword")}
          error={problem?.field === "newPassword" ? problem.message : undefined}
          required
        />
        <div>
          <Button
            type="submit"
            loading={saving}
            disabled={!form.newPassword || (user.hasPassword && !form.currentPassword)}
          >
            {user.hasPassword ? "Change password" : "Set password"}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}
