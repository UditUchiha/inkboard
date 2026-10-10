import { useEffect, useState } from "react";
import { API_URL } from "../config";
import { toast } from "sonner";
import { api } from "../lib/api";
import { startSignIn } from "../lib/signIn";
import { buttonClass } from "./Button";

export function GoogleIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.1-4 1.1-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24Z"
      />
      <path fill="#FBBC05" d="M5.4 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z" />
    </svg>
  );
}

export function GitHubIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2.2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.9 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

export const PROVIDER_ICONS = { google: GoogleIcon, github: GitHubIcon };

// The list rarely changes, so it's fetched once per page load.
let providersRequest = null;

// What the server offers for signing in: Google and GitHub (when set up), and
// whether email (verification, password reset) is on. Loaded once per page load.
function useAuthOptions() {
  const [options, setOptions] = useState({ providers: [], email: false });
  useEffect(() => {
    let active = true;
    providersRequest ??= api.listProviders().then(
      (data) => ({ providers: data.providers, email: Boolean(data.email) }),
      () => {
        providersRequest = null;
        return { providers: [], email: false };
      },
    );
    providersRequest.then((loaded) => active && setOptions(loaded));
    return () => {
      active = false;
    };
  }, []);
  return options;
}

export const useOAuthProviders = () => useAuthOptions().providers;

/** Whether email verification and password reset are switched on. */
export const useEmailEnabled = () => useAuthOptions().email;

// `bind` is the hash from startSignIn: the server needs it to tie the end of the sign-in to this tab.
export const oauthStartUrl = (provider, next, bind) =>
  `${API_URL}/api/auth/oauth/${provider}?bind=${encodeURIComponent(bind)}${next ? `&next=${encodeURIComponent(next)}` : ""}`;

/** "Continue with Google / GitHub", for whichever providers the server has set up. */
export function OAuthButtons({ next, className }) {
  const providers = useOAuthProviders();
  if (providers.length === 0) return null;

  // Makes the tab's `bind` first (see lib/signIn.js), so what comes back can only sign in this tab.
  async function start(provider) {
    const bind = await startSignIn();
    if (!bind) {
      toast.error("Your browser won't let this tab keep a sign-in going. Allow site storage and try again.");
      return;
    }
    window.location.assign(oauthStartUrl(provider, next, bind));
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-3 text-sm text-graphite" aria-hidden>
        <span className="h-px flex-1 bg-rule" />
        or
        <span className="h-px flex-1 bg-rule" />
      </div>
      <div className="mt-4 grid gap-2">
        {providers.map(({ id, label }) => {
          const Icon = PROVIDER_ICONS[id];
          return (
            <button
              key={id}
              type="button"
              onClick={() => start(id)}
              className={buttonClass({ variant: "secondary", size: "lg", className: "w-full" })}
            >
              {Icon && <Icon className="size-[18px]" />}
              Continue with {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
