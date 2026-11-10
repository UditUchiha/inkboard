import { LogOut } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "../../../components/Button";
import { api, errorMessage } from "../../../lib/api";
import { useAuth } from "../../../providers/AuthProvider";
import { SettingsSection } from "./SettingsSection";

export function SessionsSection() {
  const { logout } = useAuth();
  const [busy, setBusy] = useState(false);

  async function logoutEverywhere() {
    setBusy(true);
    try {
      await api.logoutEverywhere();
      logout();
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <SettingsSection
      title="Where you're logged in"
      description="Logging out on this device leaves your other devices logged in. If you've lost one, or used a computer that isn't yours, log out everywhere, this device included."
    >
      <Button variant="secondary" icon={LogOut} loading={busy} onClick={logoutEverywhere}>
        Log out everywhere
      </Button>
    </SettingsSection>
  );
}
