import { Navigate, NavLink, useLocation } from "react-router-dom";
import { Activity, HeartPulse, LayoutDashboard, Users, Shield } from "lucide-react";
import { useApp } from "@/context/AppContext";
import AdminOverview from "@/pages/AdminOverview";
import AdminLobbies from "@/pages/AdminLobbies";
import AdminAccess from "@/pages/AdminAccess";
import AdminSystemHealth from "@/pages/AdminSystemHealth";
import AdminPlayers from "@/pages/AdminPlayers";
import AdminPlayerDetail from "@/pages/AdminPlayerDetail";

const STAFF_ROLES = new Set(["admin", "moderator", "support"]);

export default function Admin() {
  const { me } = useApp();
  const { pathname } = useLocation();
  if (!STAFF_ROLES.has(me?.role)) return <Navigate to="/home" replace />;

  const accessPage = pathname.endsWith("/access");
  const lobbiesPage = pathname.endsWith("/lobbies");
  const systemHealthPage = pathname.endsWith("/system-health");
  const playersPage = pathname === "/admin/players";
  const playerDetailMatch = pathname.match(/^\/admin\/players\/([^/]+)$/);
  if (systemHealthPage && me.role !== "admin") return <Navigate to="/admin" replace />;
  return (
    <div className="space-y-6" data-testid="admin-page">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="eyebrow">Secure operations</p><h1 className="mt-2 font-display text-3xl sm:text-4xl">Admin Control Center</h1><p className="mt-2 text-sm text-muted-foreground">Live operations and player account management.</p></div>
        <span className="rounded-full border border-amber-200/20 bg-amber-200/5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-100" data-testid="admin-role">{me.role.replaceAll("_", " ")}</span>
      </header>
      <div className="grid min-w-0 gap-5 lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-6">
        <nav className="flex gap-2 overflow-x-auto rounded-2xl border border-border bg-card/50 p-2 lg:sticky lg:top-24 lg:h-fit lg:flex-col" aria-label="Admin sections" data-testid="admin-navigation">
          <NavLink end to="/admin" className={({ isActive }) => `inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold ${isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"}`}><LayoutDashboard size={14} /> Overview</NavLink>
          <NavLink to="/admin/lobbies" className={({ isActive }) => `inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold ${isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"}`}><Activity size={14} /> Live lobbies</NavLink>
          <NavLink to="/admin/players" className={({ isActive }) => `inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold ${isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"}`}><Users size={14} /> Players</NavLink>
          {me.role === "admin" && <NavLink to="/admin/access" className={({ isActive }) => `inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold ${isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"}`}><Shield size={14} /> Access roles</NavLink>}
          {me.role === "admin" && <NavLink to="/admin/system-health" className={({ isActive }) => `inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold ${isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"}`}><HeartPulse size={14} /> System health</NavLink>}
          <span className="ml-auto hidden items-center gap-1.5 px-2 py-2 text-[10px] text-muted-foreground lg:inline-flex"><Users size={12} /> Server verified</span>
        </nav>
        <section className="min-w-0">{accessPage ? <AdminAccess /> : lobbiesPage ? <AdminLobbies /> : systemHealthPage ? <AdminSystemHealth /> : playerDetailMatch ? <AdminPlayerDetail playerId={decodeURIComponent(playerDetailMatch[1])} /> : playersPage ? <AdminPlayers /> : <AdminOverview />}</section>
      </div>
    </div>
  );
}
