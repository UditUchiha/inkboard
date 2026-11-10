import { useSearchParams } from "react-router";
import { ForgotPasswordScreen } from "../features/auth/components/ForgotPasswordScreen";
import { LoginScreen } from "../features/auth/components/LoginScreen";
import { RegisterScreen } from "../features/auth/components/RegisterScreen";
import { ResetPasswordScreen } from "../features/auth/components/ResetPasswordScreen";
import { VerifyEmailScreen } from "../features/auth/components/VerifyEmailScreen";

// After login or sign-up <GuestOnly> redirects to ?next=… or /boards; Google and GitHub come back through /auth/callback.

export function LoginPage() {
  const [params] = useSearchParams();
  return <LoginScreen next={params.get("next")} errorCode={params.get("error")} provider={params.get("provider")} />;
}

export function RegisterPage() {
  const [params] = useSearchParams();
  return <RegisterScreen next={params.get("next")} />;
}

export function ForgotPasswordPage() {
  const [params] = useSearchParams();
  return <ForgotPasswordScreen initialEmail={params.get("email") ?? ""} />;
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  return <ResetPasswordScreen token={params.get("token")} />;
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  return <VerifyEmailScreen token={params.get("token")} linkEmail={params.get("email")} />;
}
