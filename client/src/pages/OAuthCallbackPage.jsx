import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { FullPageLoader } from "../components/RouteGuards";
import { useAuth } from "../providers/AuthProvider";

// Only follow redirects to paths inside the app.
const safeNext = (value) => (value?.startsWith("/") && !value.startsWith("//") ? value : "/boards");

/**
 * Google and GitHub sign-in end here, with the login token in the URL fragment.
 * The token is stored, the fragment is cleared from history, and the person
 * continues to where they were headed.
 */
export default function OAuthCallbackPage() {
  const { adoptToken, status } = useAuth();
  const [result] = useState(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    return { token: params.get("token"), next: safeNext(params.get("next")) };
  });

  useEffect(() => {
    window.history.replaceState(null, "", window.location.pathname);
    if (result.token) adoptToken(result.token);
  }, [result, adoptToken]);

  if (!result.token || status === "anonymous") {
    return <Navigate to={`/login?error=${encodeURIComponent("Sign-in didn't finish. Try again.")}`} replace />;
  }
  if (status === "authenticated") return <Navigate to={result.next} replace />;
  return <FullPageLoader label="Signing you in" />;
}
