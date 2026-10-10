import clsx from "clsx";
import { Check, Link2Off, LogOut } from "lucide-react";
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
import { formColor } from "../lib/profileColor";
import { isProvider, providerLabel, signInErrorMessage } from "../lib/signInErrors";
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
  // null: picked automatically. An old palette color shows as the one that replaced it, ready to save;
  // any other custom color is kept as it is.
  const [color, setColor] = useState(formColor(user.color));
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

// Connecting a provider leaves the app for the provider's site and comes back to Settings. What comes back is
// only accepted with the `bind` value kept here, in this tab, when it asked (see oauth.controller.js), so a
// connect link made by someone else can't attach this person's Google or GitHub to that someone's account.
const CONNECTING_KEY = "inkboard.connecting";

function rememberConnecting(provider, bind) {
  try {
    sessionStorage.setItem(CONNECTING_KEY, JSON.stringify({ provider, bind }));
  } catch {
    // Storage unavailable: the connection can't be confirmed when it comes back, and says so then.
  }
}

function takeConnecting(provider) {
  try {
    const kept = JSON.parse(sessionStorage.getItem(CONNECTING_KEY) ?? "null");
    sessionStorage.removeItem(CONNECTING_KEY);
    return kept?.provider === provider ? kept.bind : null;
  } catch {
    return null;
  }
}

// Forgets a connection that was started but never came back, and says which provider it was for.
function dropConnecting() {
  try {
    const kept = JSON.parse(sessionStorage.getItem(CONNECTING_KEY) ?? "null");
    sessionStorage.removeItem(CONNECTING_KEY);
    return kept?.provider ?? null;
  } catch {
    return null;
  }
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
      const { url, bind } = await api.linkProvider(provider);
      rememberConnecting(provider, bind);
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
  const { user, startSession } = useAuth();
  const [form, setForm] = useState({ currentPassword: "", newPassword: "" });
  const [saving, setSaving] = useState(false);
  // Which field a problem is about: { field: "currentPassword" | "newPassword", message }.
  const [problem, setProblem] = useState(null);

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  async function save(event) {
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
      const aboutCurrent = /current password/i.test(saveError.message);
      setProblem({ field: aboutCurrent ? "currentPassword" : "newPassword", message: saveError.message });
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
    </Section>
  );
}

function SessionsSection() {
  const { logout } = useAuth();
  const [busy, setBusy] = useState(false);

  async function logoutEverywhere() {
    setBusy(true);
    try {
      await api.logoutEverywhere();
      logout();
    } catch (error) {
      toast.error(error.message);
      setBusy(false);
    }
  }

  return (
    <Section
      title="Where you're logged in"
      description="Logging out on this device leaves your other devices logged in. If you've lost one, or used a computer that isn't yours, log out everywhere, this device included."
    >
      <Button variant="secondary" icon={LogOut} loading={busy} onClick={logoutEverywhere}>
        Log out everywhere
      </Button>
    </Section>
  );
}

export default function SettingsPage() {
  const { user, updateUser } = useAuth();
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    document.title = `Settings · ${APP_NAME}`;
  }, []);

  // Coming back from connecting Google or GitHub that failed: the address holds an error code, never text
  // to show (see lib/signInErrors.js).
  useEffect(() => {
    const error = params.get("error");
    if (!error) return;
    dropConnecting(); // that connection is over, with this message
    toast.error(signInErrorMessage(error, params.get("provider")));
    setParams({}, { replace: true });
  }, [params, setParams]);

  // Coming back from connecting one that worked, with a note of the account in the fragment, which is
  // confirmed with the `bind` value this tab kept. The fragment is cleared first, so it's only used once.
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const connect = fragment.get("connect");
    const provider = fragment.get("provider");
    if (!connect) {
      // A connection this tab started that didn't come back (the login ran out on the way, or the person went
      // back from the provider's page) isn't left to look as if it worked. One that failed has its own
      // message (above), which also forgot it.
      const unfinished = dropConnecting();
      if (isProvider(unfinished)) {
        toast.error(`Connecting ${providerLabel(unfinished)} didn't finish. Try again.`);
      }
      return;
    }
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    if (!isProvider(provider)) return;
    const bind = takeConnecting(provider);
    if (!bind) {
      toast.error(signInErrorMessage("link-expired", provider));
      return;
    }
    api
      .confirmProviderLink(provider, { connect, bind })
      .then(({ user: fresh }) => {
        updateUser(fresh);
        toast.success(`${providerLabel(provider)} connected`);
      })
      .catch((error) => toast.error(error.message));
  }, [updateUser]);

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
          <SessionsSection />
        </div>
      </main>
    </div>
  );
}
