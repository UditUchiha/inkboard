import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Link } from "react-router";
import { Button } from "../../../components/Button";
import { PasswordField, TextField } from "../../../components/Field";
import { OAuthButtons } from "../../../components/OAuthButtons";
import { errorMessage } from "../../../lib/api";
import { useAuth } from "../../../providers/AuthProvider";
import { nextQuery, savingDrawing } from "../lib/links";
import { AuthLayout, ErrorMessage } from "./AuthLayout";

interface RegisterScreenProps {
  next: string | null;
}

export function RegisterScreen({ next }: RegisterScreenProps) {
  const { register } = useAuth();
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
      setError(errorMessage(registerError));
      setSubmitting(false);
    }
  }

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
