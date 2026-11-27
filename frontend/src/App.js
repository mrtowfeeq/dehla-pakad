import "@/App.css";
import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Show, SignIn, SignUp } from "@clerk/react";
import { Toaster } from "@/components/ui/sonner";
import ClerkAuthProvider, { authAppearance } from "@/components/auth/ClerkAuthProvider";
import { AuthPage } from "@/components/auth/AuthPage";
import { AppProvider, useApp } from "@/context/AppContext";
import { AppShell } from "@/components/AppShell";
import { Onboarding } from "@/components/Onboarding";
import { GlobalNotifications } from "@/components/GlobalNotifications";
import { ProgressionPresenter } from "@/components/leagues/ProgressionPresenter";
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
import Wallet from "@/pages/Wallet";
import Admin from "@/pages/Admin";
import JoinRoom from "@/pages/JoinRoom";
import SpectatorGamesList from "@/pages/SpectatorGamesList";
import SpectatorView from "@/pages/SpectatorView";

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
      <ProgressionPresenter />
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
                <Route path="/sign-in/*" element={<AuthPage alt={{ text: "New here?", label: "Create a free account", to: "/sign-up" }}><SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" withSignUp appearance={authAppearance} /></AuthPage>} />
                <Route path="/sign-up/*" element={<AuthPage><SignUp routing="path" path="/sign-up" signInUrl="/sign-in" appearance={authAppearance} /></AuthPage>} />
                <Route path="/home" element={<Protected><Dashboard /></Protected>} />
                <Route path="/play" element={<Protected><Matchmaking /></Protected>} />
                <Route path="/rooms/new" element={<Protected><CreateRoom /></Protected>} />
                <Route path="/join/:code" element={<Protected><JoinRoom /></Protected>} />
                <Route path="/room/:code" element={<Protected><Lobby /></Protected>} />
                <Route path="/game/:gameId" element={<Protected bare><GameTable /></Protected>} />
                <Route path="/spectate" element={<Protected><SpectatorGamesList /></Protected>} />
                <Route path="/spectate/:gameId" element={<Protected bare><SpectatorView /></Protected>} />
                <Route path="/admin/spectate/:gameId" element={<Protected bare><SpectatorView adminSpectator /></Protected>} />
                <Route path="/profile/:username" element={<Protected><Profile /></Protected>} />
                <Route path="/friends" element={<Protected><Friends /></Protected>} />
                <Route path="/history" element={<Protected><History /></Protected>} />
                <Route path="/leaderboard" element={<Protected><Leaderboard /></Protected>} />
                <Route path="/settings" element={<Protected><Settings /></Protected>} />
                <Route path="/wallet" element={<Protected><Wallet /></Protected>} />
                <Route path="/admin/*" element={<Protected><Admin /></Protected>} />
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
