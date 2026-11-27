import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Bot, Layers, Swords, Users } from "lucide-react";
import { PlayingCard } from "@/components/PlayingCard";
import { AuthNotice } from "@/components/auth/AuthNotice";

const TENS = ["10H", "10S", "10D", "10C"];

function TensFan({ size = "md", spread = 34, lift = 6 }) {
  return (
    <div className="relative flex h-full w-full items-end justify-center" aria-hidden="true">
      {TENS.map((c, i) => (
        <motion.div key={c} className="absolute bottom-0"
          initial={{ opacity: 0, y: 30, rotate: 0, x: 0 }}
          animate={{ opacity: 1, y: Math.abs(i - 1.5) * lift, rotate: (i - 1.5) * 12, x: (i - 1.5) * spread }}
          transition={{ delay: 0.15 + i * 0.1, type: "spring", stiffness: 120, damping: 15 }}>
          <PlayingCard card={c} size={size} className="shadow-[0_14px_28px_-12px_rgba(0,0,0,.9)]" />
        </motion.div>
      ))}
    </div>
  );
}

function Brand({ className = "" }) {
  return (
    <Link to="/" className={`inline-flex items-center gap-2.5 ${className}`} data-testid="auth-brand">
      <span className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-amber-100/70 bg-gradient-to-br from-amber-100 via-amber-300 to-amber-600 font-mono text-sm font-black text-slate-950 shadow-[inset_0_2px_0_rgba(255,255,255,.5),0_0_18px_rgba(251,191,36,.35)]" aria-hidden="true">10</span>
      <span className="font-display text-2xl font-bold text-amber-200">Dehla Pakad</span>
    </Link>
  );
}

// Frame for the Clerk sign-in and sign-up forms. Desktop: a showcase panel on the left and the form on the
// right. Phones: a compact brand header and fanned tens above the form. Always the dark felt look.
// alt: { text, label, to } link under the form to switch pages. Used on sign-in, where Clerk's combined
// sign-in-or-up form shows no "Sign up" link; Clerk's sign-up form already links back to sign-in.
export function AuthPage({ children, alt = null }) {
  return (
    <div className="felt grain relative min-h-screen overflow-hidden text-white" data-testid="auth-page">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_55%_at_15%_0%,rgba(251,191,36,.16),transparent_60%),radial-gradient(ellipse_70%_70%_at_100%_100%,rgba(0,0,0,.55),transparent_70%)]" aria-hidden="true" />
      <div className="relative mx-auto grid min-h-screen max-w-6xl lg:grid-cols-[1fr_minmax(0,460px)] lg:gap-10">
        <aside className="hidden flex-col justify-between p-12 lg:flex" data-testid="auth-showcase">
          <Brand />
          <div>
            <p className="eyebrow !text-amber-200/70">Capture the tens</p>
            <h1 className="mt-3 font-display text-5xl leading-tight text-white">
              Four players.<br />Two teams.<br /><span className="bg-gradient-to-r from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-transparent">Four tens to claim.</span>
            </h1>
            <div className="mt-10 h-40 w-80"><TensFan size="lg" spread={46} /></div>
            <ul className="mt-10 flex flex-wrap gap-2 text-xs text-white/70">
              {[[Users, "4 players · 2 teams"], [Swords, "Public matchmaking"], [Layers, "Private rooms"], [Bot, "Practise with bots"]].map(([Icon, text]) => (
                <li key={text} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/25 px-3 py-1.5">
                  <Icon size={13} className="text-amber-200/80" aria-hidden="true" />{text}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-sm text-white/45">Registration is required to play.</p>
        </aside>

        <main className="flex min-w-0 flex-col items-center justify-center px-4 py-8 sm:py-12">
          <div className="mb-6 flex flex-col items-center text-center lg:hidden" data-testid="auth-mobile-brand">
            <Brand />
            <p className="mt-2 text-xs text-emerald-50/65">Four players · Two teams · Four tens to claim</p>
            <div className="mt-4 h-20 w-56"><TensFan size="sm" spread={24} lift={4} /></div>
          </div>
          <AuthNotice />
          {children}
          {alt && (
            <p className="mt-5 text-center text-sm text-white/65" data-testid="auth-alt">
              {alt.text}{" "}
              <Link to={alt.to} className="font-semibold text-amber-300 underline-offset-4 hover:text-amber-200 hover:underline" data-testid="auth-alt-link">{alt.label}</Link>
            </p>
          )}
          <p className="mt-3 text-center text-[11px] text-white/40 lg:hidden">Registration is required to play.</p>
        </main>
      </div>
    </div>
  );
}
