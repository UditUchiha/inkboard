import { Link2Off } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "../../../components/Button";
import { PROVIDER_ICONS, useOAuthProviders } from "../../../components/OAuthButtons";
import { API_URL, APP_NAME } from "../../../config";
import { api, errorMessage } from "../../../lib/api";
import { useAuth } from "../../../providers/AuthProvider";
import { rememberConnecting } from "../lib/connecting";
import type { SignedIn } from "../types/signedIn";
import { SettingsSection } from "./SettingsSection";

export function ConnectedAccounts() {
  const { user, updateUser } = useAuth() as SignedIn;
  const providers = useOAuthProviders();
  const [busy, setBusy] = useState<string | null>(null);

  // Providers that are connected but no longer configured on the server still need a way out.
  const rows = providers.length
    ? providers
    : Object.keys(user.providers ?? {})
        .filter((id) => user.providers[id])
        .map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
  if (rows.length === 0) return null;

  async function connect(provider: string) {
    setBusy(provider);
    try {
      const { url, bind } = await api.linkProvider(provider);
      rememberConnecting(provider, bind);
      window.location.assign(`${API_URL}${url}`);
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(null);
    }
  }

  async function disconnect(provider: string, label: string) {
    setBusy(provider);
    try {
      const { user: updated } = await api.disconnectProvider(provider);
      updateUser(updated);
      toast.success(`${label} disconnected`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection
      title="Connected accounts"
      description={`Log in to ${APP_NAME} with one click instead of a password.`}
    >
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
    </SettingsSection>
  );
}
