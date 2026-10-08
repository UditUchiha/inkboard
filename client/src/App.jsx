import { Compass } from "lucide-react";
import { BrowserRouter, Route, Routes } from "react-router";
import { Toaster } from "sonner";
import { ButtonLink } from "./components/Button";
import { FullPageMessage, GuestOnly, RequireAuth } from "./components/RouteGuards";
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from "./pages/AuthPages";
import BoardPage from "./pages/BoardPage";
import DashboardPage from "./pages/DashboardPage";
import DrawPage from "./pages/DrawPage";
import LandingPage from "./pages/LandingPage";
import OAuthCallbackPage from "./pages/OAuthCallbackPage";
import SettingsPage from "./pages/SettingsPage";
import { AuthProvider } from "./providers/AuthProvider";
import { NotificationsProvider } from "./providers/NotificationsProvider";
import { SocketProvider } from "./providers/SocketProvider";
import { ThemeProvider, useTheme } from "./providers/ThemeProvider";

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
            </NotificationsProvider>
          </SocketProvider>
          <ThemedToaster />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
