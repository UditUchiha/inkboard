import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button, ButtonLink } from "../../../components/Button";
import { VerifyEmailNotice } from "../../../components/VerifyEmailNotice";
import { api, errorMessage } from "../../../lib/api";
import { verifyView } from "../../../lib/verifyLink";
import { useAuth } from "../../../providers/AuthProvider";
import { nextQuery } from "../lib/links";
import { AuthLayout, LoginLink } from "./AuthLayout";

interface VerifyEmailScreenProps {
  token: string | null;
  linkEmail: string | null;
}

type VerifyResult =
  { phase: "ready" } | { phase: "verifying" } | { phase: "done"; email: string } | { phase: "failed"; message: string };

export function VerifyEmailScreen({ token, linkEmail }: VerifyEmailScreenProps) {
  const { status, user, updateUser, logout, retry } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // Opening the link only asks for confirmation: mail scanners and previews open links too, and a link works once.
  const [result, setResult] = useState<VerifyResult>(
    token
      ? { phase: "ready" }
      : { phase: "failed", message: "This link is incomplete. Open the link from the email again." },
  );

  function verify() {
    setResult({ phase: "verifying" });
    api
      .verifyEmail(token as string)
      .then(({ email, user: verified }) => {
        updateUser(verified); // seen as verified straight away
        setResult({ phase: "done", email });
      })
      .catch((error: unknown) => setResult({ phase: "failed", message: errorMessage(error) }));
  }

  // The link only verifies the account it was sent for, for someone logged in to it, so the page says who is logged in
  // and offers to switch when it's another account (verifyView).
  const view = verifyView({ status, user, linkEmail });
  const signedIn = view === "confirm" || view === "switch";
  const here = `${location.pathname}${location.search}`;
  function switchAccount() {
    logout();
    navigate(`/login${nextQuery(here)}`);
  }
  const switchButton = (
    <button type="button" onClick={switchAccount} className="font-medium text-ink underline underline-offset-4">
      Switch account
    </button>
  );

  let subtitle = "This takes a moment.";
  if (result.phase === "done") subtitle = `${result.email} is verified. People can now invite you to their boards.`;
  else if (result.phase === "failed") subtitle = result.message;
  else if (result.phase === "ready") {
    subtitle = {
      loading: "Confirm that this is your address.",
      offline: "We couldn't reach the server to see who's logged in.",
      login: "Log in to the account this email was sent for, then confirm that this is your address.",
      switch: `You're logged in as ${user?.email}, but this link was sent to a different account.`,
      confirm: `You're logged in as ${user?.email}. Confirm that this is your address.`,
    }[view];
  }

  return (
    <AuthLayout
      title={
        {
          ready: "Verify your email",
          verifying: "Verifying your email…",
          done: "Email verified",
          failed: "That link didn't work",
        }[result.phase]
      }
      subtitle={subtitle}
      footer={
        view === "login" ? (
          <>
            Have an account? <LoginLink />
          </>
        ) : null
      }
    >
      {result.phase === "ready" && view === "offline" && (
        <Button size="lg" onClick={retry} className="w-full">
          Try again
        </Button>
      )}
      {result.phase === "ready" && view === "login" && (
        <ButtonLink to={`/login${nextQuery(here)}`} size="lg" className="w-full">
          Log in to verify
        </ButtonLink>
      )}
      {result.phase === "ready" && view === "switch" && (
        <Button size="lg" onClick={switchAccount} className="w-full">
          Switch account
        </Button>
      )}
      {result.phase === "ready" && (view === "loading" || view === "confirm") && (
        <div className="grid gap-4">
          <Button size="lg" onClick={verify} disabled={view === "loading"} className="w-full">
            {user ? `Verify ${user.email}` : "Verify my email"}
          </Button>
          {user && <p className="text-center text-sm text-graphite">Not your account? {switchButton}</p>}
        </div>
      )}
      {result.phase === "done" && (
        <ButtonLink to="/boards" size="lg" className="w-full">
          Go to your boards
        </ButtonLink>
      )}
      {result.phase === "failed" && view === "offline" && (
        <Button size="lg" onClick={retry} className="w-full">
          Try again
        </Button>
      )}
      {result.phase === "failed" && signedIn && (
        <div className="grid gap-4">
          <VerifyEmailNotice />
          <p className="text-sm text-graphite">
            Logged in as {user!.email}. Is this link for another account? {switchButton}
          </p>
        </div>
      )}
      {result.phase === "failed" && view === "login" && (
        <p className="text-[15px] text-graphite">
          Log in to get a new link: there's a button for it on your boards page.
        </p>
      )}
    </AuthLayout>
  );
}
