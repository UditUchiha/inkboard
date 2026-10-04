import { useEffect } from "react";
import { Link } from "react-router";
import { ButtonLink } from "../components/Button";
import { Logo } from "../components/Logo";
import { APP_NAME } from "../config";
import { DemoBoard } from "../features/landing/DemoBoard";
import { useAuth } from "../providers/AuthProvider";

const FEATURES = [
  {
    title: "See who's drawing",
    body: "Everyone on a board gets a named cursor, so you can follow along or point at things while you talk.",
  },
  {
    title: "Hand-drawn or clean",
    body: "Shapes start out sketchy so ideas look unfinished on purpose. Switch any of them to crisp lines when they're ready.",
  },
  {
    title: "Saved as you draw",
    body: "Every stroke is stored the moment you make it. Close the tab whenever you like and come back to the same board.",
  },
  {
    title: "Pens, fingers, trackpads",
    body: "Pressure-sensitive strokes with a stylus, pinch to zoom on touch screens, and keyboard shortcuts for every tool.",
  },
];

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
            <h1 className="text-[clamp(3rem,2rem+5vw,5.75rem)] leading-[0.92] font-extrabold tracking-[-0.02em] [font-stretch:72%]">
              Draw it out, together.
            </h1>
            <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-graphite">
              {APP_NAME} is a hand-drawn whiteboard that syncs as you sketch. Invite people by email, watch their
              cursors move, and come back to every board exactly as you left it.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              {signedIn ? (
                <ButtonLink to="/boards" size="lg">
                  Open your boards
                </ButtonLink>
              ) : (
                <>
                  <ButtonLink to="/register" size="lg">
                    Create a free board
                  </ButtonLink>
                  <ButtonLink to="/login" size="lg" variant="secondary">
                    Log in
                  </ButtonLink>
                </>
              )}
            </div>
          </div>
          <DemoBoard />
        </section>

        <section aria-labelledby="features-heading" className="border-t border-rule bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="features-heading" className="sr-only">
              What you get
            </h2>
            <div className="grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((feature) => (
                <div key={feature.title}>
                  <h3 className="text-lg font-bold">{feature.title}</h3>
                  <p className="mt-2 leading-relaxed text-graphite">{feature.body}</p>
                </div>
              ))}
            </div>
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
