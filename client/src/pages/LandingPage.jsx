import { Suspense, useEffect } from "react";
import { Link } from "react-router";
import { ButtonLink } from "../components/Button";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Logo } from "../components/Logo";
import { APP_NAME } from "../config";
import { SCENE_HEIGHT, SCENE_WIDTH } from "../features/landing/demoScene";
import { lazyPage } from "../lib/chunkReload";
import { useAuth } from "../providers/AuthProvider";

// The sample board brings the whole renderer with it, so it loads after the page itself.
const DemoBoard = lazyPage(() => import("../features/landing/DemoBoard"));

function DemoPaper() {
  return (
    <div
      className="graph-paper rounded-xl border border-rule [--cell:20px]"
      style={{ aspectRatio: `${SCENE_WIDTH} / ${SCENE_HEIGHT}` }}
    />
  );
}

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
  {
    title: "Draw first, sign up later",
    body: "Start a board with no account. It's kept in your browser until you decide to save it to your own boards.",
  },
  {
    title: "Share by link or by email",
    body: "Let anyone with the link view or edit, or invite specific people. Guests can join in without signing up.",
  },
  {
    title: "Comments and mentions",
    body: "Pin a comment to any spot on the board, @mention a teammate and resolve threads when they're done.",
  },
  {
    title: "Version history",
    body: "Boards are checkpointed as you work. Name a version, preview an old one and restore it for everyone.",
  },
  {
    title: "Follow along",
    body: "Click someone's avatar and your view follows theirs, so a walkthrough lands where you point.",
  },
  {
    title: "Templates",
    body: "Start from a kanban, flowchart or retro board, or save any of your boards as a template to reuse.",
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
              {APP_NAME} is a hand-drawn whiteboard that syncs as you sketch. Start drawing right now, no account
              needed. Sign up when you want to keep boards, invite people and come back to them exactly as you left
              them.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              {signedIn ? (
                <ButtonLink to="/boards" size="lg">
                  Open your boards
                </ButtonLink>
              ) : (
                <>
                  <ButtonLink to="/draw" size="lg">
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
          <ErrorBoundary fallback={DemoPaper}>
            <Suspense fallback={<DemoPaper />}>
              <DemoBoard />
            </Suspense>
          </ErrorBoundary>
        </section>

        <section aria-labelledby="features-heading" className="border-t border-rule bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="features-heading" className="sr-only">
              What you get
            </h2>
            <div className="grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
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
