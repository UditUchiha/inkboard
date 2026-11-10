import { useEffect } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Logo } from "../../../components/Logo";
import { APP_NAME } from "../../../config";

type AuthLayoutProps = { title: string; subtitle: ReactNode; children: ReactNode; footer: ReactNode };

export function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
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

export function ErrorMessage({ children }: ErrorMessageProps) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

export function LoginLink() {
  return (
    <Link to="/login" className="font-medium text-ink underline underline-offset-4">
      Log in
    </Link>
  );
}
