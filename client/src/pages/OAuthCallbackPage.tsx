import { WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router";
import { Button } from "../components/Button";
import { FullPageLoader, FullPageMessage } from "../components/RouteGuards";
import { api } from "../lib/api";
import type { Session } from "../lib/api";
import { completeSignIn } from "../lib/signIn";
import { loginWithError, safeNext } from "../lib/signInErrors";
import { useAuth } from "../providers/AuthProvider";

type Completed = Awaited<ReturnType<typeof completeSignIn>> & { session: Session };
type Phase = Completed["outcome"] | "exchanging";

// The code in the URL fragment is traded with this tab's `bind` (lib/signIn.ts); a redirect not started here has none,
// so someone else's link can't sign this browser in to their account.
export default function OAuthCallbackPage() {
  const { startSession } = useAuth();
  const [result] = useState(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    return { code: params.get("code"), next: safeNext(params.get("next")) };
  });
  const [phase, setPhase] = useState<Phase>("exchanging");
  const started = useRef(false);

  const finish = useCallback(async () => {
    setPhase("exchanging");
    const { outcome, session } = (await completeSignIn({
      code: result.code,
      exchange: api.exchangeOAuthCode,
    })) as Completed;
    if (outcome === "signed-in") startSession(session);
    setPhase(outcome);
  }, [result, startSession]);

  useEffect(() => {
    window.history.replaceState(null, "", window.location.pathname);
    // Once only: a code works once, and the effect runs twice in development.
    if (started.current) return;
    started.current = true;
    finish();
  }, [finish]);

  // Back to log in with an error code, keeping where the person was headed.
  if (phase === "incomplete") return <Navigate to={loginWithError("incomplete", result.next)} replace />;
  if (phase === "offline") {
    return (
      <FullPageMessage
        icon={WifiOff}
        title="Can't reach the server"
        action={<Button onClick={finish}>Try again</Button>}
      >
        Your sign-in couldn't be finished. Check your connection and try again.
      </FullPageMessage>
    );
  }
  if (phase === "signed-in") return <Navigate to={result.next} replace />;
  return <FullPageLoader label="Signing you in" />;
}
