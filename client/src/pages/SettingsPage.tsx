import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { AppHeader } from "../components/AppHeader";
import { VerifyEmailNotice } from "../components/VerifyEmailNotice";
import { APP_NAME } from "../config";
import { ApiTokensSection } from "../features/settings/components/ApiTokensSection";
import { ConnectedAccounts } from "../features/settings/components/ConnectedAccounts";
import { ImageSpaceSection } from "../features/settings/components/ImageSpaceSection";
import { PasswordSection } from "../features/settings/components/PasswordSection";
import { ProfileSection } from "../features/settings/components/ProfileSection";
import { SessionsSection } from "../features/settings/components/SessionsSection";
import { dropConnecting, takeConnecting } from "../features/settings/lib/connecting";
import type { SignedIn } from "../features/settings/types/signedIn";
import { api, errorMessage } from "../lib/api";
import { isProvider, providerLabel, signInErrorMessage } from "../lib/signInErrors";
import { useAuth } from "../providers/AuthProvider";

export default function SettingsPage() {
  const { user, updateUser } = useAuth() as SignedIn;
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    document.title = `Settings · ${APP_NAME}`;
  }, []);

  // A failed connect returns an error code in the address, never text to show (lib/signInErrors.ts).
  useEffect(() => {
    const error = params.get("error");
    if (!error) return;
    dropConnecting(); // that connection is over, with this message
    toast.error(signInErrorMessage(error, params.get("provider") as string));
    setParams({}, { replace: true });
  }, [params, setParams]);

  // A successful connect brings a note of the account in the fragment, confirmed with this tab's `bind`; cleared first so it's used once.
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const connect = fragment.get("connect");
    const provider = fragment.get("provider") as string;
    if (!connect) {
      // A connection this tab started that didn't come back (login ran out, person went back) mustn't look like it worked; a failed one has its own message above.
      const unfinished = dropConnecting() as string;
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
      .catch((error: unknown) => toast.error(errorMessage(error)));
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
          <ImageSpaceSection />
          <ApiTokensSection />
          <SessionsSection />
        </div>
      </main>
    </div>
  );
}
