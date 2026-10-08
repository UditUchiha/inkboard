import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Button, ButtonLink } from "../components/Button";
import { PasswordField, TextField } from "../components/Field";
import { Logo } from "../components/Logo";
import { OAuthButtons } from "../components/OAuthButtons";
import { VerifyEmailNotice } from "../components/VerifyEmailNotice";
import { APP_NAME } from "../config";
import { api } from "../lib/api";
import { useAuth } from "../providers/AuthProvider";

// After a successful login or sign-up, <GuestOnly> redirects to ?next=… or /boards.
// Google and GitHub sign-in come back through /auth/callback instead.

const nextQuery = (next) => (next ? `?next=${encodeURIComponent(next)}` : "");

// Signing up from a guest board brings the drawing along (see DrawPage).
const savingDrawing = (next) => next === "/draw";

function AuthLayout({ title, subtitle, children, footer }) {
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

function ErrorMessage({ children }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ email: "", password: "" });
  // Google or GitHub sign-in that failed comes back here with ?error=…
  const [error, setError] = useState(params.get("error") ?? "");
  const [submitting, setSubmitting] = useState(false);

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(form);
    } catch (loginError) {
      setError(loginError.message);
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
        <TextField label="Email" type="email" autoComplete="email" value={form.email} onChange={update("email")} required autoFocus />
        <PasswordField label="Password" autoComplete="current-password" value={form.password} onChange={update("password")} required />
        <Link
          to={`/forgot-password${form.email ? `?email=${encodeURIComponent(form.email)}` : ""}`}
          className="-mt-2 justify-self-end rounded-sm text-sm font-medium text-graphite underline-offset-4 hover:text-ink hover:underline"
        >
          Forgot password?
        </Link>
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

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  async function submit(event) {
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
      setError(registerError.message);
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
        <TextField label="Name" autoComplete="name" value={form.name} onChange={update("name")} required maxLength={60} autoFocus />
        <TextField label="Email" type="email" autoComplete="email" value={form.email} onChange={update("email")} required />
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
  const [sentTo, setSentTo] = useState(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await api.forgotPassword(email.trim());
      setSentTo(email.trim());
    } catch (sendError) {
      setError(sendError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle={sentTo ? "Check your email." : "Enter your account's email and we'll send you a link to choose a new password."}
      footer={<>Remembered it? {loginLink}</>}
    >
      {sentTo ? (
        <div className="grid gap-3 text-[15px]">
          <p>
            If an account uses <strong className="font-semibold">{sentTo}</strong>, a link to reset its password is on its way. It
            works for 1 hour.
          </p>
          <p className="text-graphite">
            Not there after a few minutes? Check your spam folder, or{" "}
            <button type="button" onClick={() => setSentTo(null)} className="font-medium text-ink underline underline-offset-4">
              try again
            </button>
            .
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus />
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
  const [error, setError] = useState(token ? "" : "This link is incomplete. Open the link from the email again, or ask for a new one.");
  const [passwordError, setPasswordError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setPasswordError("");
    if (password.length < 8) {
      setPasswordError("Use at least 8 characters.");
      return;
    }
    setSubmitting(true);
    try {
      startSession(await api.resetPassword({ token, password }));
      toast.success("Password changed. You're logged in.");
      navigate("/boards", { replace: true });
    } catch (resetError) {
      setError(resetError.message);
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

export function VerifyEmailPage() {
  const { status, updateUser } = useAuth();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [result, setResult] = useState(
    token ? { phase: "verifying" } : { phase: "failed", message: "This link is incomplete. Open the link from the email again." },
  );
  // A link works once, so it's sent once, even if React runs the effect twice.
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    api
      .verifyEmail(token)
      .then(({ email }) => setResult({ phase: "done", email }))
      .catch((error) => setResult({ phase: "failed", message: error.message }));
  }, [token]);

  // Someone logged in sees their account as verified straight away.
  useEffect(() => {
    if (result.phase !== "done" || status !== "authenticated") return;
    api
      .me()
      .then(({ user }) => updateUser(user))
      .catch(() => {});
  }, [result.phase, status, updateUser]);

  const signedIn = status === "authenticated";
  return (
    <AuthLayout
      title={{ verifying: "Verifying your email…", done: "Email verified", failed: "That link didn't work" }[result.phase]}
      subtitle={
        result.phase === "done"
          ? `${result.email} is verified. People can now invite you to their boards.`
          : result.phase === "failed"
            ? result.message
            : "This takes a moment."
      }
      footer={signedIn ? null : <>Have an account? {loginLink}</>}
    >
      {result.phase === "done" && (
        <ButtonLink to={signedIn ? "/boards" : "/login"} size="lg" className="w-full">
          {signedIn ? "Go to your boards" : "Log in"}
        </ButtonLink>
      )}
      {result.phase === "failed" &&
        (signedIn ? (
          <VerifyEmailNotice />
        ) : (
          <p className="text-[15px] text-graphite">Log in to get a new link: there's a button for it on your boards page.</p>
        ))}
    </AuthLayout>
  );
}
