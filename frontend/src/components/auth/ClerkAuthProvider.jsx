import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ClerkProvider } from "@clerk/react";
import { dark } from "@clerk/ui/themes";
import { useTheme } from "next-themes";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

// The sign-in and sign-up pages always use the dark felt frame (AuthPage), so their forms always use this
// navy-and-gold card, whatever the site theme. Other Clerk screens (account manager) follow the theme.
// Game wording for the form titles instead of Clerk's "Continue to <application name>". The sign-in page uses
// Clerk's combined sign-in-or-up flow, which reads the *Combined keys. Later Clerk steps still use the
// application name set in the Clerk dashboard.
const authLocalization = {
  signIn: {
    start: {
      title: "Welcome back", subtitle: "Sign in to take your seat at the table",
      titleCombined: "Welcome to the table", subtitleCombined: "Sign in or create an account to play",
    },
  },
  signUp: { start: { title: "Create your account", subtitle: "Join the table — it's free" } },
};

export const authAppearance = {
  theme: dark,
  captcha: { theme: "dark" },
  variables: {
    colorPrimary: "#f5b833",
    colorPrimaryForeground: "#0b1220",
    colorBackground: "#0f1a2e",
    colorForeground: "#fff7e6",
    colorMutedForeground: "#b6c2d6",
    colorInput: "#0a1222",
    colorInputForeground: "#ffffff",
    colorBorder: "rgba(252, 211, 77, 0.22)",
    colorRing: "rgba(245, 184, 51, 0.55)",
    fontFamily: "Plus Jakarta Sans, sans-serif",
    fontFamilyButtons: "Plus Jakarta Sans, sans-serif",
    borderRadius: "0.75rem",
  },
  elements: {
    cardBox: "!rounded-3xl !border !border-amber-300/30 !shadow-[0_30px_70px_-30px_rgba(0,0,0,.95),0_0_40px_-20px_rgba(251,191,36,.35)]",
    card: "!bg-gradient-to-b !from-[#16233d] !to-[#0b1324]",
    headerTitle: "!font-display !text-2xl !tracking-wide !text-amber-50",
    headerSubtitle: "!text-white/60",
    formButtonPrimary: "!bg-gradient-to-r !from-amber-300 !to-amber-500 !font-bold !text-slate-950 !shadow-[0_10px_24px_-10px_rgba(251,191,36,.7)] hover:!from-amber-200 hover:!to-amber-400",
    footerActionLink: "!font-semibold !text-amber-300 hover:!text-amber-200",
  },
};

export default function ClerkAuthProvider({ children }) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const [config, setConfig] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const isDark = resolvedTheme !== "light";
  const appearance = {
    ...(isDark ? { theme: dark, captcha: { theme: "dark" } } : {}),
    variables: {
      colorPrimary: isDark ? "#f5b833" : "#d97706",
      colorPrimaryForeground: "#0b1220",
      fontFamily: "Plus Jakarta Sans, sans-serif",
      borderRadius: "0.75rem",
      ...(isDark ? { colorBackground: "#0f1729" } : {}),
    },
  };

  useEffect(() => {
    let cancelled = false;
    const load = async (attempt = 0) => {
      try {
        const cfg = await (await fetch(`${BACKEND_URL}/api/clerk/config`)).json();
        if (cfg.enabled) return cancelled || setConfig(cfg);
      } catch {}
      if (cancelled) return;
      if (attempt >= 20) return setUnavailable(true);
      setTimeout(() => load(attempt + 1), 1500);
    };
    load();
    return () => { cancelled = true; };
  }, []);

  if (unavailable) return <p style={{ padding: 24 }}>Sign-in is unavailable right now. Refresh the page to try again.</p>;
  if (!config) return null;
  return (
    <ClerkProvider
      publishableKey={config.publishable_key}
      proxyUrl={config.proxy_url || undefined}
      appearance={appearance}
      localization={authLocalization}
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      afterSignOutUrl="/"
    >
      {children}
    </ClerkProvider>
  );
}
