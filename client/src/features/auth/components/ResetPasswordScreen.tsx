import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "../../../components/Button";
import { PasswordField } from "../../../components/Field";
import { api, errorMessage } from "../../../lib/api";
import { useAuth } from "../../../providers/AuthProvider";
import { AuthLayout, ErrorMessage } from "./AuthLayout";

interface ResetPasswordScreenProps {
  token: string | null;
}

export function ResetPasswordScreen({ token }: ResetPasswordScreenProps) {
  const { startSession } = useAuth();
  const navigate = useNavigate();
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
      startSession(await api.resetPassword({ token, password } as { token: string; password: string }));
      toast.success("Password changed. You're logged in.");
      navigate("/boards", { replace: true });
    } catch (resetError) {
      setError(errorMessage(resetError));
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
