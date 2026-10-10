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

// What completeSignIn resolves with, plus the `session` that only comes with "signed-in" (the one outcome it's used for).
type Completed = Awaited<ReturnType<typeof completeSignIn>> & { session: Session };
type Phase = Completed["outcome"] | "exchanging";

/**
 * Google and GitHub sign-in end here, with a short-lived code in the URL fragment (never a login). The
 * code is traded, together with the `bind` this tab kept when it started signing in, for the login
 * (see lib/signIn.ts). A redirect that wasn't started in this tab has no `bind` to go with it, so
 * following someone else's link can't sign this browser in to their account. The fragment is cleared
 * from history, and the person continues to where they were headed.
 */
export default function OAuthCallbackPage() {
  const { startSession } = useAuth();
  const [result] = useState(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    return { code: params.get("code"), next: safeNext(params.get("next")) };
  });
  // "exchanging" while the code is being traded, then "signed-in", "offline" (try again) or "incomplete".
  const [phase, setPhase] = useState<Phase>("exchanging");
  const started = useRef(false);

  const finish = useCallback(async () => {
    setPhase("exchanging");
    // completeSignIn's result type has `session` on one outcome only, so reading it here needs the type above.
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

  // Back to the log in page, with a code for the message and where the person was headed, so trying again
  // still gets them there.
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
