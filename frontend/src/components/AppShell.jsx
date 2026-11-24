import { Link, NavLink } from "react-router-dom";
import { UserButton } from "@clerk/react";
import { Home, Swords, Users, History, Trophy, Settings, Shield } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { ThemeToggle } from "@/components/ThemeToggle";

const NAV = [
  { to: "/home", label: "Home", icon: Home, id: "home" },
  { to: "/play", label: "Play", icon: Swords, id: "play" },
  { to: "/friends", label: "Friends", icon: Users, id: "friends" },
  { to: "/history", label: "History", icon: History, id: "history" },
  { to: "/leaderboard", label: "Ranks", icon: Trophy, id: "leaderboard" },
];

export function AppShell({ children }) {
  const { me, connected } = useApp();
  const items = [...NAV, { to: "/settings", label: "Settings", icon: Settings, id: "settings" }];
  if (me?.role === "admin") items.push({ to: "/admin", label: "Admin", icon: Shield, id: "admin" });
  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center gap-6">
          <Link to="/home" className="font-display text-lg font-bold text-primary" data-testid="nav-logo">Dehla Pakad</Link>
          <nav className="hidden md:flex items-center gap-1">
            {items.map((n) => (
              <NavLink key={n.to} to={n.to} data-testid={`nav-${n.id}`}
                className={({ isActive }) => `px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span data-testid="socket-status" title={connected ? "Connected" : "Reconnecting"}
              className={`hidden sm:inline-flex items-center gap-1.5 text-xs ${connected ? "text-emerald-400" : "text-amber-400"}`}>
              <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400 animate-pulse"}`} />
              {connected ? "Online" : "Connecting"}
            </span>
            <Link to={`/profile/${me?.username}`} className="hidden sm:block text-sm font-semibold hover:text-primary" data-testid="nav-profile">{me?.username}</Link>
            <ThemeToggle />
            <UserButton />
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-8 md:py-12">{children}</main>
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-border bg-background/90 backdrop-blur-xl grid grid-cols-5">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} data-testid={`mobile-nav-${n.id}`}
            className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold ${isActive ? "text-primary" : "text-muted-foreground"}`}>
            <n.icon size={20} />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
