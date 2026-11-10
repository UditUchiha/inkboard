import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Link } from "react-router";
import { Button } from "../../../components/Button";
import { PasswordField, TextField } from "../../../components/Field";
import { OAuthButtons, useEmailEnabled } from "../../../components/OAuthButtons";
import { APP_NAME } from "../../../config";
import { errorMessage } from "../../../lib/api";
import { signInErrorMessage } from "../../../lib/signInErrors";
import { useAuth } from "../../../providers/AuthProvider";
import { nextQuery, savingDrawing } from "../lib/links";
import { AuthLayout, ErrorMessage } from "./AuthLayout";

interface LoginScreenProps {
  next: string | null;
  errorCode: string | null;
  provider: string | null;
}

export function LoginScreen({ next, errorCode, provider }: LoginScreenProps) {
  const { login } = useAuth();
  const emailEnabled = useEmailEnabled();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState(() => (errorCode ? signInErrorMessage(errorCode, provider as string) : ""));
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
      setError(errorMessage(loginError));
      setSubmitting(false);
    }
  }

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
