import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "../components/Button";
import { PasswordField, TextField } from "../components/Field";
import { Logo } from "../components/Logo";
import { OAuthButtons } from "../components/OAuthButtons";
import { APP_NAME } from "../config";
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
