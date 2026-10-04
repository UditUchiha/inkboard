import { Compass } from "lucide-react";
import { BrowserRouter, Route, Routes } from "react-router";
import { Toaster } from "sonner";
import { ButtonLink } from "./components/Button";
import { FullPageMessage, GuestOnly, RequireAuth } from "./components/RouteGuards";
import { LoginPage, RegisterPage } from "./pages/AuthPages";
import BoardPage from "./pages/BoardPage";
import DashboardPage from "./pages/DashboardPage";
import LandingPage from "./pages/LandingPage";
import { AuthProvider } from "./providers/AuthProvider";
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
        <SocketProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route
                path="/login"
                element={
                  <GuestOnly>
                    <LoginPage />
                  </GuestOnly>
                }
              />
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
                  <RequireAuth>
                    <BoardPage />
                  </RequireAuth>
                }
              />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </BrowserRouter>
          <ThemedToaster />
        </SocketProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
