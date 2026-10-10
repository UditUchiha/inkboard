import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Button, ButtonLink } from "../components/Button";
import { PasswordField, TextField } from "../components/Field";
import { Logo } from "../components/Logo";
import { OAuthButtons, useEmailEnabled } from "../components/OAuthButtons";
import { VerifyEmailNotice } from "../components/VerifyEmailNotice";
import { APP_NAME } from "../config";
import { api } from "../lib/api";
import type { AccountUser, ApiError } from "../lib/api";
import { signInErrorMessage } from "../lib/signInErrors";
import { verifyView } from "../lib/verifyLink";
import { useAuth } from "../providers/AuthProvider";

// After a successful login or sign-up, <GuestOnly> redirects to ?next=… or /boards.
// Google and GitHub sign-in come back through /auth/callback instead.

const nextQuery = (next: string | null) => (next ? `?next=${encodeURIComponent(next)}` : "");

// Signing up from a guest board brings the drawing along (see DrawPage).
const savingDrawing = (next: string | null) => next === "/draw";

type AuthLayoutProps = { title: string; subtitle: ReactNode; children: ReactNode; footer: ReactNode };

function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);

  return (
    <main className="graph-paper flex min-h-dvh flex-col items-center px-4 py-10 sm:py-16">
      <Link to="/" className="rounded-lg" aria-label={`${APP_NAME} home`}>
        <Logo />
      </Link>
      <div className="mt-10 w-full max-w-sm rounded-xl border border-rule bg-surface p-6 sm:p-8">
        <h1 className="text-[1.75rem] leading-tight font-extrabold tracking-tight [font-stretch:85%]">{title}</h1>
        <p className="mt-1.5 text-graphite">{subtitle}</p>
        <div className="mt-7">{children}</div>
      </div>
      <p className="mt-6 text-sm text-graphite">{footer}</p>
    </main>
  );
}

type ErrorMessageProps = { children: ReactNode };

function ErrorMessage({ children }: ErrorMessageProps) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const emailEnabled = useEmailEnabled();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ email: "", password: "" });
  // Google or GitHub sign-in that failed comes back here with ?error=<code>&provider=<name>.
  const [error, setError] = useState(() => {
    const code = params.get("error");
    // A link without a provider gives null, which providerLabel answers with "your account".
    return code ? signInErrorMessage(code, params.get("provider") as string) : "";
  });
  const [submitting, setSubmitting] = useState(false);

  const update = (field: keyof typeof form) => (event: ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(form);
    } catch (loginError) {
      // login rejects with an ApiError.
      setError((loginError as ApiError).message);
      setSubmitting(false);
    }
  }

  const next = params.get("next");
  let subtitle = "Pick up where you left off.";
  if (next?.startsWith("/board/")) subtitle = "Log in to open the board you were sent.";
  if (savingDrawing(next)) subtitle = "Log in and your drawing is saved to your boards.";

  return (
    <AuthLayout
      title="Log in"
      subtitle={subtitle}
      footer={
        <>
          New to {APP_NAME}?{" "}
          <Link to={`/register${nextQuery(next)}`} className="font-medium text-ink underline underline-offset-4">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={update("email")}
          required
          autoFocus
        />
        <PasswordField
          label="Password"
          autoComplete="current-password"
          value={form.password}
          onChange={update("password")}
          required
        />
        {emailEnabled && (
          <Link
            to={`/forgot-password${form.email ? `?email=${encodeURIComponent(form.email)}` : ""}`}
            className="-mt-2 justify-self-end rounded-sm text-sm font-medium text-graphite underline-offset-4 hover:text-ink hover:underline"
          >
            Forgot password?
          </Link>
        )}
        <ErrorMessage>{error}</ErrorMessage>
        <Button type="submit" size="lg" loading={submitting} className="mt-2 w-full">
          Log in
        </Button>
      </form>
      <OAuthButtons next={next} className="mt-6" />
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const update = (field: keyof typeof form) => (event: ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPasswordError("");
    if (form.password.length < 8) {
      setPasswordError("Use at least 8 characters.");
      return;
    }
    setSubmitting(true);
    try {
      await register(form);
    } catch (registerError) {
      // register rejects with an ApiError.
      setError((registerError as ApiError).message);
      setSubmitting(false);
    }
  }

  const next = params.get("next");
  return (
    <AuthLayout
      title={savingDrawing(next) ? "Save your board" : "Create your account"}
      subtitle={
        savingDrawing(next)
          ? "Create a free account to keep your drawing, open it anywhere and share it."
          : "Your name is shown to people on boards you share."
      }
      footer={
        <>
          Already have an account?{" "}
          <Link to={`/login${nextQuery(next)}`} className="font-medium text-ink underline underline-offset-4">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <TextField
          label="Name"
          autoComplete="name"
          value={form.name}
          onChange={update("name")}
          required
          maxLength={60}
          autoFocus
        />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={update("email")}
          required
        />
        <PasswordField
          label="Password"
          autoComplete="new-password"
          hint="At least 8 characters."
          error={passwordError}
          value={form.password}
          onChange={update("password")}
          required
        />
        <ErrorMessage>{error}</ErrorMessage>
        <Button type="submit" size="lg" loading={submitting} className="mt-2 w-full">
          Create account
        </Button>
      </form>
      <OAuthButtons next={next} className="mt-6" />
    </AuthLayout>
  );
}

const loginLink = (
  <Link to="/login" className="font-medium text-ink underline underline-offset-4">
    Log in
  </Link>
);

export function ForgotPasswordPage() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await api.forgotPassword(email.trim());
      setSentTo(email.trim());
    } catch (sendError) {
      // forgotPassword rejects with an ApiError.
      setError((sendError as ApiError).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle={
        sentTo ? "Check your email." : "Enter your account's email and we'll send you a link to choose a new password."
      }
      footer={<>Remembered it? {loginLink}</>}
    >
      {sentTo ? (
        <div className="grid gap-3 text-[15px]">
          <p>
            If an account uses <strong className="font-semibold">{sentTo}</strong>, a link to reset its password is on
            its way. It works for 1 hour.
          </p>
          <p className="text-graphite">
            Not there after a few minutes? Check your spam folder, or{" "}
            <button
              type="button"
              onClick={() => setSentTo(null)}
              className="font-medium text-ink underline underline-offset-4"
            >
              try again
            </button>
            .
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoFocus
          />
          <ErrorMessage>{error}</ErrorMessage>
          <Button type="submit" size="lg" loading={submitting} disabled={!email.trim()} className="mt-2 w-full">
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { startSession } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(
    token ? "" : "This link is incomplete. Open the link from the email again, or ask for a new one.",
  );
  const [passwordError, setPasswordError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPasswordError("");
    if (password.length < 8) {
      setPasswordError("Use at least 8 characters.");
      return;
    }
    setSubmitting(true);
    try {
      // The field and the button are disabled without a token, so the form can't be sent without one.
      startSession(await api.resetPassword({ token, password } as { token: string; password: string }));
      toast.success("Password changed. You're logged in.");
      navigate("/boards", { replace: true });
    } catch (resetError) {
      // resetPassword rejects with an ApiError.
      setError((resetError as ApiError).message);
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle="Use it the next time you log in with your email."
      footer={
        <>
          Need a new link?{" "}
          <Link to="/forgot-password" className="font-medium text-ink underline underline-offset-4">
            Send one
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <PasswordField
          label="New password"
          autoComplete="new-password"
          hint="At least 8 characters."
          error={passwordError}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoFocus
          disabled={!token}
        />
        <ErrorMessage>{error}</ErrorMessage>
        <Button type="submit" size="lg" loading={submitting} disabled={!token} className="mt-2 w-full">
          Save password and log in
        </Button>
      </form>
    </AuthLayout>
  );
}

// Where verifying the address has got to: it only gets past "ready" through the button, which needs a token.
type VerifyResult =
  { phase: "ready" } | { phase: "verifying" } | { phase: "done"; email: string } | { phase: "failed"; message: string };

export function VerifyEmailPage() {
  const { status, user, updateUser, logout, retry } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  // Opening the link only asks for confirmation: mail scanners and link previews open links too, and a
  // link works once, so it's used up by the person's click and not by a visit.
  const [result, setResult] = useState<VerifyResult>(
    token
      ? { phase: "ready" }
      : { phase: "failed", message: "This link is incomplete. Open the link from the email again." },
  );

  function verify() {
    setResult({ phase: "verifying" });
    // The "ready" phase, where the button that calls this is shown, only happens with a token. The server answers
    // with the address that was verified and the account as it is now.
    (api.verifyEmail(token as string) as Promise<{ email: string; user: AccountUser }>)
      .then(({ email, user: verified }) => {
        updateUser(verified); // seen as verified straight away
        setResult({ phase: "done", email });
      })
      // verifyEmail rejects with an ApiError.
      .catch((error: ApiError) => setResult({ phase: "failed", message: error.message }));
  }

  // The link only verifies the account it was sent for, for someone logged in to it, which shows the inbox
  // and the account's password are in the same hands (see verifyEmail on the server). So the page says who
  // is logged in, and when that isn't the account the link names (its `email`, a hint only: the server decides),
  // offers to switch rather than a button that can't work. Logging in comes back here.
  const view = verifyView({ status, user, linkEmail: params.get("email") });
  // Only these two views come with a logged in account (see verifyView), so `user` is set wherever signedIn is.
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
          verifying: "Verifying your email�",
          done: "Email verified",
          failed: "That link didn't work",
        }[result.phase]
      }
      subtitle={subtitle}
      footer={view === "login" ? <>Have an account? {loginLink}</> : null}
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
