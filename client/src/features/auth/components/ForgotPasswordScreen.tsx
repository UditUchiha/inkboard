import { useState } from "react";
import type { FormEvent } from "react";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/Field";
import { api, errorMessage } from "../../../lib/api";
import { AuthLayout, ErrorMessage, LoginLink } from "./AuthLayout";

interface ForgotPasswordScreenProps {
  initialEmail: string;
}

export function ForgotPasswordScreen({ initialEmail }: ForgotPasswordScreenProps) {
  const [email, setEmail] = useState(initialEmail);
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
      setError(errorMessage(sendError));
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
      footer={
        <>
          Remembered it? <LoginLink />
        </>
      }
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
