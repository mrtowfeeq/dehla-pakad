import "@/App.css";
import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Show, SignIn, SignUp } from "@clerk/react";
import { Toaster } from "@/components/ui/sonner";
import ClerkAuthProvider from "@/components/auth/ClerkAuthProvider";
import { AppProvider, useApp } from "@/context/AppContext";
import { AppShell } from "@/components/AppShell";
import { Onboarding } from "@/components/Onboarding";
import { GlobalNotifications } from "@/components/GlobalNotifications";
import { SoundBridge } from "@/components/SoundBridge";
import Landing from "@/pages/Landing";
import Dashboard from "@/pages/Dashboard";
import Matchmaking from "@/pages/Matchmaking";
import CreateRoom from "@/pages/CreateRoom";
import Lobby from "@/pages/Lobby";
import GameTable from "@/pages/GameTable";
import Profile from "@/pages/Profile";
import Friends from "@/pages/Friends";
import History from "@/pages/History";
import Leaderboard from "@/pages/Leaderboard";
import Settings from "@/pages/Settings";
import Admin from "@/pages/Admin";
import JoinRoom from "@/pages/JoinRoom";

function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center" data-testid="app-loading">
      <div className="font-display text-xl text-primary animate-pulse">Dehla Pakad</div>
    </div>
  );
}

function SignedInGate({ children, bare }) {
  const { me, meError, refreshMe } = useApp();
  if (meError && !me)
    return (
      <div className="min-h-screen flex flex-col gap-3 items-center justify-center">
        <p>Could not load your profile.</p>
        <button className="btn-ghost" onClick={refreshMe} data-testid="retry-profile-btn">Retry</button>
      </div>
    );
  if (!me) return <Loading />;
  if (!me.username) return <Onboarding />;
  return (
    <>
      <GlobalNotifications />
      <SoundBridge />
      {bare ? children : <AppShell>{children}</AppShell>}
    </>
  );
}

function Protected({ children, bare }) {
  return (
    <>
      <Show when="signed-in"><SignedInGate bare={bare}>{children}</SignedInGate></Show>
      <Show when="signed-out"><Navigate to="/sign-in" replace /></Show>
    </>
  );
}

function AuthPage({ children }) {
  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="hidden lg:flex felt grain relative flex-col justify-between p-12 overflow-hidden">
        <div className="font-display text-2xl text-amber-300">Dehla Pakad</div>
        <div>
          <p className="eyebrow !text-amber-200/70">Capture the tens</p>
          <h1 className="font-display text-5xl text-white mt-3 leading-tight">Four players.<br />Two teams.<br />Four tens to claim.</h1>
        </div>
        <p className="text-slate-300/70 text-sm">Registration is required to play.</p>
      </div>
      <div className="flex items-center justify-center p-4 py-10">{children}</div>
    </div>
  );
}

function Home() {
  return (
    <>
      <Show when="signed-out"><Landing /></Show>
      <Show when="signed-in"><Navigate to="/home" replace /></Show>
    </>
  );
}

function RegisterSW() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}

function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <div className="App">
        <RegisterSW />
        <BrowserRouter>
          <ClerkAuthProvider>
            <AppProvider>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/sign-in/*" element={<AuthPage><SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" withSignUp /></AuthPage>} />
                <Route path="/sign-up/*" element={<AuthPage><SignUp routing="path" path="/sign-up" signInUrl="/sign-in" /></AuthPage>} />
                <Route path="/home" element={<Protected><Dashboard /></Protected>} />
                <Route path="/play" element={<Protected><Matchmaking /></Protected>} />
                <Route path="/rooms/new" element={<Protected><CreateRoom /></Protected>} />
                <Route path="/join/:code" element={<Protected><JoinRoom /></Protected>} />
                <Route path="/room/:code" element={<Protected><Lobby /></Protected>} />
                <Route path="/game/:gameId" element={<Protected bare><GameTable /></Protected>} />
                <Route path="/profile/:username" element={<Protected><Profile /></Protected>} />
                <Route path="/friends" element={<Protected><Friends /></Protected>} />
                <Route path="/history" element={<Protected><History /></Protected>} />
                <Route path="/leaderboard" element={<Protected><Leaderboard /></Protected>} />
                <Route path="/settings" element={<Protected><Settings /></Protected>} />
                <Route path="/admin" element={<Protected><Admin /></Protected>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppProvider>
          </ClerkAuthProvider>
        </BrowserRouter>
        <Toaster position="top-center" richColors />
      </div>
    </ThemeProvider>
  );
}

export default App;
