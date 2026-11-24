import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Swords, Users, Trophy, ShieldCheck, Wifi, Sparkles } from "lucide-react";
import { PlayingCard } from "@/components/PlayingCard";
import { ThemeToggle } from "@/components/ThemeToggle";

const FEATURES = [
  { icon: Swords, title: "Real-time tables", text: "Four players, two teams, live from any device. The server deals and judges every card." },
  { icon: Sparkles, title: "Koth & 13 Mann", text: "Chase all four tens for Koth, or sweep the first seven tricks and gamble on a Grand Slam." },
  { icon: Users, title: "Friends & private rooms", text: "Share a six-letter invite code, seat your partner opposite and pick the dealer." },
  { icon: Trophy, title: "Stats & leaderboard", text: "Every Normal Win, Koth and Grand Slam is recorded in your history." },
  { icon: Wifi, title: "Drop-proof", text: "Lost signal? Your seat and cards wait for you. Reconnect and play on." },
  { icon: ShieldCheck, title: "Fair play", text: "Hands are private, decks are shuffled with secure randomness, no peeking." },
];

const HERO_CARDS = ["10H", "10S", "10D", "10C"];

export default function Landing() {
  return (
    <div className="min-h-screen" data-testid="landing-page">
      <header className="absolute top-0 inset-x-0 z-20">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between">
          <span className="font-display text-xl font-bold text-amber-300">Dehla Pakad</span>
          <div className="flex items-center gap-3">
            <ThemeToggle className="text-white border-white/20" />
            <Link to="/sign-in" className="text-sm font-semibold text-white/80 hover:text-white" data-testid="landing-login-link">Log in</Link>
            <Link to="/sign-up" className="btn-gold !py-2 text-sm" data-testid="landing-register-btn">Register</Link>
          </div>
        </div>
      </header>

      <section className="relative felt grain overflow-hidden min-h-[92vh] flex items-center">
        <div className="max-w-6xl mx-auto px-5 pt-24 pb-16 grid lg:grid-cols-[1.1fr_1fr] gap-14 items-center w-full">
          <div className="relative z-10">
            <p className="eyebrow !text-amber-200/80 rise">The Indian game of tens</p>
            <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl text-white mt-4 leading-[1.05] rise" style={{ animationDelay: ".08s" }}>
              Capture the tens.<br /><span className="text-amber-300">Claim the table.</span>
            </h1>
            <p className="mt-6 text-base md:text-lg text-slate-300 max-w-lg rise" style={{ animationDelay: ".16s" }}>
              Dehla Pakad online — a premium four-player trick-taking table with partners, trump, Koth and the legendary 13 Mann.
            </p>
            <div className="mt-10 flex flex-wrap gap-3 rise" style={{ animationDelay: ".24s" }}>
              <Link to="/sign-up" className="btn-gold text-base px-7 py-3" data-testid="hero-get-started-btn">Create free account</Link>
              <Link to="/sign-in" className="btn-ghost !bg-white/5 !border-white/15 text-white px-6 py-3" data-testid="hero-login-btn">I have an account</Link>
            </div>
          </div>
          <div className="relative h-[340px] sm:h-[420px] flex items-center justify-center">
            <div className="absolute w-72 h-72 sm:w-96 sm:h-96 rounded-full border border-amber-300/15" />
            <div className="absolute w-52 h-52 sm:w-72 sm:h-72 rounded-full border border-amber-300/10" />
            {HERO_CARDS.map((c, i) => (
              <motion.div key={c} className="absolute"
                initial={{ opacity: 0, y: 60, rotate: 0 }}
                animate={{ opacity: 1, y: 0, rotate: (i - 1.5) * 14, x: (i - 1.5) * 58 }}
                transition={{ delay: 0.3 + i * 0.12, type: "spring", stiffness: 90, damping: 14 }}
                whileHover={{ y: -18 }}>
                <PlayingCard card={c} size="lg" testId={`hero-card-${i}`} />
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-5 py-24">
        <p className="eyebrow">Why play here</p>
        <h2 className="font-display text-3xl mt-3 max-w-xl">Built for the way families and friends actually play.</h2>
        <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-12">
          {FEATURES.map((f) => (
            <div key={f.title} className="group">
              <f.icon className="text-primary transition-transform group-hover:-translate-y-1" size={26} />
              <h3 className="font-bold text-lg mt-4">{f.title}</h3>
              <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border">
        <div className="max-w-6xl mx-auto px-5 py-20 grid md:grid-cols-3 gap-10">
          {[["Normal Win", "1 pt", "Three tens, or the 7–6 trick split when tens are 2–2."],
            ["Koth", "2 pts", "Declare after your third ten — the fourth decides everything."],
            ["Grand Slam", "3 pts", "Sweep the first seven tricks, then win all thirteen."]].map(([t, p, d]) => (
            <div key={t} className="border-l-2 border-primary/60 pl-5">
              <div className="font-mono text-primary text-sm">{p}</div>
              <div className="font-display text-xl mt-1">{t}</div>
              <p className="text-sm text-muted-foreground mt-2">{d}</p>
            </div>
          ))}
        </div>
      </section>
      <footer className="py-10 text-center text-xs text-muted-foreground">© Dehla Pakad · Registration required to play</footer>
    </div>
  );
}
