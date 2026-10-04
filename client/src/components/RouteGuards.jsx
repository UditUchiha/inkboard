import { LoaderCircle, WifiOff } from "lucide-react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import { useAuth } from "../providers/AuthProvider";
import { Button } from "./Button";

export function FullPageMessage({ icon: Icon, title, children, action }) {
  return (
    <main className="graph-paper grid min-h-dvh place-items-center px-4">
      <div className="max-w-md text-center">
        {Icon && <Icon className="mx-auto size-8 text-graphite" strokeWidth={1.5} aria-hidden />}
        <h1 className="mt-4 text-2xl font-bold tracking-tight">{title}</h1>
        {children && <div className="mt-2 text-graphite">{children}</div>}
        {action && <div className="mt-6 flex justify-center gap-2">{action}</div>}
      </div>
    </main>
  );
}

export function FullPageLoader({ label = "Loading" }) {
  return (
    <div className="graph-paper grid min-h-dvh place-items-center" role="status">
      <div className="flex items-center gap-2 text-graphite">
        <LoaderCircle className="size-5 animate-spin" aria-hidden />
        <span>{label}…</span>
      </div>
    </div>
  );
}

export function RequireAuth({ children }) {
  const { status, retry } = useAuth();
  const location = useLocation();

  if (status === "loading") return <FullPageLoader />;
  if (status === "offline") {
    return (
      <FullPageMessage
        icon={WifiOff}
        title="Can't reach the server"
        action={<Button onClick={retry}>Try again</Button>}
      >
        Check your connection. If you're running Inkboard locally, make sure the API is running.
      </FullPageMessage>
    );
  }
  if (status === "anonymous") {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return children;
}

// Only follow redirects to paths inside the app.
function safeNext(value) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/boards";
}

/** Login and sign-up pages: once signed in, continue to where the person was headed. */
export function GuestOnly({ children }) {
  const { status } = useAuth();
  const [params] = useSearchParams();
  if (status === "authenticated") return <Navigate to={safeNext(params.get("next"))} replace />;
  return children;
}
