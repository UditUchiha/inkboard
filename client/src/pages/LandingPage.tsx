import { ArrowRight } from "lucide-react";
import { Suspense, useEffect } from "react";
import type { CSSProperties } from "react";
import { Link } from "react-router";
import { ButtonLink } from "../components/Button";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Logo } from "../components/Logo";
import { APP_NAME } from "../config";
import { SCENE_HEIGHT, SCENE_WIDTH } from "../features/landing/lib/demoScene";
import { FEATURES, STEPS } from "../features/landing/constants/features";
import { lazyPage } from "../lib/chunkReload";
import { useAuth } from "../providers/AuthProvider";

// The sample board brings the whole renderer with it, so it loads after the page itself.
const DemoBoard = lazyPage(() => import("../features/landing/components/DemoBoard"));

function DemoPaper() {
  return (
    <div
      className="graph-paper rounded-xl border border-rule [--cell:20px]"
      style={{ aspectRatio: `${SCENE_WIDTH} / ${SCENE_HEIGHT}` }}
    />
  );
}

export default function LandingPage() {
  const { status } = useAuth();
  const signedIn = status === "authenticated";

  useEffect(() => {
    document.title = `${APP_NAME} · Draw it out, together`;
  }, []);

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="rounded-lg" aria-label={`${APP_NAME} home`}>
          <Logo />
        </Link>
        <nav className="flex items-center gap-2">
          {signedIn ? (
            <ButtonLink to="/boards">Your boards</ButtonLink>
          ) : (
            <>
              <ButtonLink to="/login" variant="ghost">
                Log in
              </ButtonLink>
              <ButtonLink to="/register">Sign up</ButtonLink>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-10 pb-20 sm:px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:pt-16">
          <div className="max-w-xl">
            <p className="rise-in inline-flex items-center gap-2 rounded-full border border-rule bg-surface px-3 py-1 text-sm font-medium text-graphite">
              <span className="size-2 rounded-full bg-marker" aria-hidden="true" />
              Free to use, no account needed
            </p>
            <h1
              className="rise-in mt-5 text-[clamp(3rem,2rem+5vw,5.75rem)] leading-[0.92] font-extrabold tracking-[-0.02em] [font-stretch:72%]"
              style={{ "--i": 1 } as CSSProperties}
            >
              Draw it out, together.
            </h1>
            <p
              className="rise-in mt-6 max-w-[34rem] text-lg leading-relaxed text-graphite"
              style={{ "--i": 2 } as CSSProperties}
            >
              {APP_NAME} is a hand-drawn whiteboard that syncs as you sketch. Start drawing right now, no account
              needed. Sign up when you want to keep boards, invite people and come back to them exactly as you left
              them.
            </p>
            <div className="rise-in mt-8 flex flex-wrap gap-3" style={{ "--i": 3 } as CSSProperties}>
              {signedIn ? (
                <ButtonLink to="/boards" size="lg">
                  Open your boards
                </ButtonLink>
              ) : (
                <>
                  <ButtonLink to="/draw" size="lg" icon={ArrowRight}>
                    Start drawing
                  </ButtonLink>
                  <ButtonLink to="/register" size="lg" variant="secondary">
                    Create an account
                  </ButtonLink>
                </>
              )}
            </div>
          </div>
          {/* The sample board is decoration: if it can't load, the empty paper stays and the page still works. */}
          <div className="rise-in" style={{ "--i": 2 } as CSSProperties}>
            <ErrorBoundary fallback={DemoPaper}>
              <Suspense fallback={<DemoPaper />}>
                <DemoBoard />
              </Suspense>
            </ErrorBoundary>
          </div>
        </section>

        <section aria-labelledby="steps-heading" className="border-t border-rule bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="steps-heading" className="sr-only">
              How it works
            </h2>
            <ol className="grid gap-8 sm:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="flex gap-4">
                  <span className="font-hand text-4xl leading-none font-bold text-signal" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div>
                    <h3 className="text-lg font-bold">{step.title}</h3>
                    <p className="mt-1 leading-relaxed text-graphite">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="features-heading" className="border-t border-rule">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="features-heading" className="text-3xl font-extrabold tracking-tight [font-stretch:80%]">
              Everything a whiteboard should do, and a few things it usually doesn't.
            </h2>
            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <li
                  key={title}
                  className="rounded-2xl border border-rule bg-surface p-5 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_-12px_var(--color-ink)]"
                >
                  <Icon className="size-5 text-signal" aria-hidden="true" />
                  <h3 className="mt-3 text-lg font-bold">{title}</h3>
                  <p className="mt-1 leading-relaxed text-graphite">{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-rule bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-graphite sm:px-6">
          <span>
            © {new Date().getFullYear()} {APP_NAME}
          </span>
          <span>Built with React, Node.js, Socket.IO and MongoDB.</span>
        </div>
      </footer>
    </div>
  );
}
