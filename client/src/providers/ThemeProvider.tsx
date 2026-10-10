import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

const THEME_KEY = "inkboard.theme";

/** What is on screen, and what the person chose: one of the two, or to follow the system. */
export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

/** What `useTheme()` gives. */
export type ThemeValue = {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeValue | null>(null);

// The page color browsers show around the app (the paper color of each theme). index.html has one tag per
// system theme; this makes them follow the theme that was chosen instead.
const BROWSER_COLORS: Record<Theme, string> = { light: "#f3f6f4", dark: "#121b2e" };

const systemPrefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

type ThemeProviderProps = { children: ReactNode };

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [preference, setPreference] = useState(readPreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    for (const tag of document.querySelectorAll('meta[name="theme-color"]')) {
      tag.removeAttribute("media");
      tag.setAttribute("content", BROWSER_COLORS[theme]);
    }
  }, [theme]);

  const choose = useCallback((next: ThemePreference) => {
    setPreference(next);
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // Preference just won't persist.
    }
  }, []);

  const value = useMemo<ThemeValue>(() => ({ theme, preference, setPreference: choose }), [theme, preference, choose]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}
