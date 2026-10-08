import clsx from "clsx";
import { Check, Link2Off } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { AppHeader } from "../components/AppHeader";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { PasswordField, TextField } from "../components/Field";
import { PROVIDER_ICONS, useOAuthProviders } from "../components/OAuthButtons";
import { VerifyEmailNotice } from "../components/VerifyEmailNotice";
import { API_URL, APP_NAME } from "../config";
import { api } from "../lib/api";
import { PEOPLE_COLORS, colorFor } from "../lib/format";
import { useAuth } from "../providers/AuthProvider";

function Section({ title, description, children }) {
  return (
    <section className="rounded-xl border border-rule bg-surface p-6">
      <h2 className="text-lg font-bold">{title}</h2>
      {description && <p className="mt-1 text-sm text-graphite">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function ProfileSection() {
  const { user, updateUser } = useAuth();
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color); // null: picked automatically
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const automatic = colorFor(user.id);
  const changed = name.trim() !== user.name || color !== user.color;

  async function save(event) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const { user: updated } = await api.updateProfile({ name, color });
      updateUser(updated);
      setName(updated.name);
      toast.success("Profile saved");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Profile" description="Your name and color are shown to people on the boards you open.">
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
    </Section>
  );
}

function ConnectedAccounts() {
  const { user, updateUser } = useAuth();
  const providers = useOAuthProviders();
  const [busy, setBusy] = useState(null);

  // Providers that are connected but no longer configured on the server still need a way out.
  const rows = providers.length
    ? providers
    : Object.keys(user.providers ?? {})
        .filter((id) => user.providers[id])
        .map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
  if (rows.length === 0) return null;

  async function connect(provider) {
    setBusy(provider);
    try {
      const { url } = await api.linkProvider(provider);
      window.location.assign(`${API_URL}${url}`);
    } catch (error) {
      toast.error(error.message);
      setBusy(null);
    }
  }

  async function disconnect(provider, label) {
    setBusy(provider);
    try {
      const { user: updated } = await api.disconnectProvider(provider);
      updateUser(updated);
      toast.success(`${label} disconnected`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Connected accounts" description={`Log in to ${APP_NAME} with one click instead of a password.`}>
      <ul className="divide-y divide-rule">
        {rows.map(({ id, label }) => {
          const Icon = PROVIDER_ICONS[id];
          const connected = Boolean(user.providers?.[id]);
          return (
            <li key={id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              {Icon && <Icon className="size-5 shrink-0" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-sm text-graphite">{connected ? "Connected" : "Not connected"}</p>
              </div>
              {connected ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Link2Off}
                  loading={busy === id}
                  onClick={() => disconnect(id, label)}
                >
                  Disconnect
                </Button>
              ) : (
                <Button variant="secondary" size="sm" loading={busy === id} onClick={() => connect(id)}>
                  Connect
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function PasswordSection() {
  const { user, updateUser } = useAuth();
  const [form, setForm] = useState({ currentPassword: "", newPassword: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  async function save(event) {
    event.preventDefault();
    setError("");
    if (form.newPassword.length < 8) {
      setError("Use at least 8 characters for the new password.");
      return;
    }
    setSaving(true);
    try {
      const { user: updated } = await api.changePassword(form);
      updateUser(updated);
      setForm({ currentPassword: "", newPassword: "" });
      toast.success(user.hasPassword ? "Password changed" : "Password set");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
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
            required
          />
        )}
        <PasswordField
          label="New password"
          autoComplete="new-password"
          value={form.newPassword}
          onChange={update("newPassword")}
          error={error}
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
    </Section>
  );
}

export default function SettingsPage() {
  const { user, updateUser } = useAuth();
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    document.title = `Settings · ${APP_NAME}`;
  }, []);

  // Coming back from connecting Google or GitHub.
  useEffect(() => {
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error) return;
    if (error) toast.error(error);
    if (connected) {
      toast.success(`${connected[0].toUpperCase() + connected.slice(1)} connected`);
      api
        .me()
        .then(({ user: fresh }) => updateUser(fresh))
        .catch(() => {});
    }
    setParams({}, { replace: true });
  }, [params, setParams, updateUser]);

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main className="mx-auto max-w-2xl px-4 pt-10 pb-20 sm:px-6">
        <h1 className="text-[2.5rem] leading-none font-extrabold tracking-tight [font-stretch:80%]">Settings</h1>
        <p className="mt-2 text-graphite">{user.email}</p>
        <VerifyEmailNotice className="mt-4" />
        <div className="mt-8 grid gap-6">
          <ProfileSection />
          <ConnectedAccounts />
          <PasswordSection />
        </div>
      </main>
    </div>
  );
}
