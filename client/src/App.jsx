import { Compass } from "lucide-react";
import { Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { Toaster } from "sonner";
import { ButtonLink } from "./components/Button";
import { FullPageLoader, FullPageMessage, GuestOnly, RequireAuth } from "./components/RouteGuards";
import { lazyPage } from "./lib/chunkReload";
import LandingPage from "./pages/LandingPage";
import OAuthCallbackPage from "./pages/OAuthCallbackPage";
import { AuthProvider } from "./providers/AuthProvider";
import { NotificationsProvider } from "./providers/NotificationsProvider";
import { SocketProvider } from "./providers/SocketProvider";
import { ThemeProvider, useTheme } from "./providers/ThemeProvider";

// The board editor, drawing code and forms are only downloaded by the pages that use them. lazyPage reloads the app
// when a deploy has replaced those files since this tab loaded.
const BoardPage = lazyPage(() => import("./pages/BoardPage"));
const DashboardPage = lazyPage(() => import("./pages/DashboardPage"));
const DrawPage = lazyPage(() => import("./pages/DrawPage"));
const SettingsPage = lazyPage(() => import("./pages/SettingsPage"));
const authPage = (name) => lazyPage(() => import("./pages/AuthPages").then((module) => ({ default: module[name] })));
const LoginPage = authPage("LoginPage");
const RegisterPage = authPage("RegisterPage");
const ForgotPasswordPage = authPage("ForgotPasswordPage");
const ResetPasswordPage = authPage("ResetPasswordPage");
const VerifyEmailPage = authPage("VerifyEmailPage");

function NotFoundPage() {
  return (
    <FullPageMessage icon={Compass} title="This page doesn't exist" action={<ButtonLink to="/">Go home</ButtonLink>}>
      Check the address, or head back to the start.
    </FullPageMessage>
  );
}

function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} position="bottom-center" offset={84} toastOptions={{ className: "font-sans" }} />;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <SocketProvider>
            <NotificationsProvider>
              <Suspense fallback={<FullPageLoader />}>
                <Routes>
                  <Route path="/" element={<LandingPage />} />
                  <Route path="/draw" element={<DrawPage />} />
                  <Route path="/auth/callback" element={<OAuthCallbackPage />} />
                  <Route
                    path="/settings"
                    element={
                      <RequireAuth>
                        <SettingsPage />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/login"
                    element={
                      <GuestOnly>
                        <LoginPage />
                      </GuestOnly>
                    }
                  />
                  <Route
                    path="/forgot-password"
                    element={
                      <GuestOnly>
                        <ForgotPasswordPage />
                      </GuestOnly>
                    }
                  />
                  {/* Links from emails: they work whether or not someone is logged in. */}
                  <Route path="/reset-password" element={<ResetPasswordPage />} />
                  <Route path="/verify-email" element={<VerifyEmailPage />} />
                  <Route
                    path="/register"
                    element={
                      <GuestOnly>
                        <RegisterPage />
                      </GuestOnly>
                    }
                  />
                  <Route
                    path="/boards"
                    element={
                      <RequireAuth>
                        <DashboardPage />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/board/:boardId"
                    element={
                      <RequireAuth optional>
                        <BoardPage />
                      </RequireAuth>
                    }
                  />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </Suspense>
            </NotificationsProvider>
          </SocketProvider>
          <ThemedToaster />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
