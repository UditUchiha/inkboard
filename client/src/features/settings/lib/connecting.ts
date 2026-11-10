type Connecting = { provider: string; bind: string };

// Connecting leaves for the provider's site and returns here; what comes back is only accepted with the `bind` kept in
// this tab
// (oauth.controller.ts), so someone else's connect link can't attach this person's account to theirs.
const CONNECTING_KEY = "inkboard.connecting";

export function rememberConnecting(provider: string, bind: string) {
  try {
    sessionStorage.setItem(CONNECTING_KEY, JSON.stringify({ provider, bind }));
  } catch {
    // Storage unavailable: the connection can't be confirmed when it comes back, and says so then.
  }
}

export function takeConnecting(provider: string) {
  try {
    const kept: Connecting | null = JSON.parse(sessionStorage.getItem(CONNECTING_KEY) ?? "null");
    sessionStorage.removeItem(CONNECTING_KEY);
    return kept?.provider === provider ? kept.bind : null;
  } catch {
    return null;
  }
}

export function dropConnecting() {
  try {
    const kept: Connecting | null = JSON.parse(sessionStorage.getItem(CONNECTING_KEY) ?? "null");
    sessionStorage.removeItem(CONNECTING_KEY);
    return kept?.provider ?? null;
  } catch {
    return null;
  }
}
