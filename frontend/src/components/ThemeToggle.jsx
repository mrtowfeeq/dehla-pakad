import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

export function ThemeToggle({ className = "" }) {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  return (
    <button
      data-testid="theme-toggle-btn"
      aria-label="Toggle theme"
      onClick={() => setTheme(dark ? "light" : "dark")}
      className={`h-9 w-9 inline-flex items-center justify-center rounded-full border border-border hover:bg-secondary transition-colors ${className}`}
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
