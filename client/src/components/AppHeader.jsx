import { Check, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../providers/AuthProvider";
import { useTheme } from "../providers/ThemeProvider";
import { Avatar } from "./Avatar";
import { Logo } from "./Logo";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./Menu";

const THEMES = [
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
  ["system", "Match system", Monitor],
];

export function UserMenu() {
  const { user, logout } = useAuth();
  const { preference, setPreference } = useTheme();
  const navigate = useNavigate();

  return (
    <Menu
      trigger={(props) => (
        <button type="button" aria-label="Account menu" className="rounded-full" {...props}>
          <Avatar id={user.id} name={user.name} size="md" />
        </button>
      )}
    >
      <div className="px-2.5 py-2">
        <p className="truncate text-sm font-semibold">{user.name}</p>
        <p className="truncate text-sm text-graphite">{user.email}</p>
      </div>
      <MenuSeparator />
      <MenuLabel>Theme</MenuLabel>
      {THEMES.map(([value, label, Icon]) => (
        <MenuItem
          key={value}
          icon={Icon}
          onSelect={() => setPreference(value)}
          hint={preference === value ? <Check className="size-4" /> : null}
        >
          {label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        icon={LogOut}
        onSelect={() => {
          logout();
          navigate("/");
        }}
      >
        Log out
      </MenuItem>
    </Menu>
  );
}

export function AppHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-paper/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/boards" className="rounded-lg" aria-label="Your boards">
          <Logo />
        </Link>
        <UserMenu />
      </div>
    </header>
  );
}
