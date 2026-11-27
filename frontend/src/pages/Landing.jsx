import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Bot, Crown, Flame, Layers, ShieldCheck, Sparkles, Swords, Trophy, Users, Wifi } from "lucide-react";
import { PlayingCard } from "@/components/PlayingCard";
import { ThemeToggle } from "@/components/ThemeToggle";

const FEATURES = [
  { icon: Swords, tone: "bg-amber-300/15 text-amber-200", title: "Real-time tables", text: "Four players, two teams, live from any device. The server deals and judges every card." },
  { icon: Sparkles, tone: "bg-rose-400/15 text-rose-200", title: "Koth & 13 Mann", text: "Chase all four tens for Koth, or sweep the first seven tricks and gamble on a Grand Slam." },
  { icon: Users, tone: "bg-sky-400/15 text-sky-200", title: "Friends & private rooms", text: "Share a six-letter invite code, seat your partner opposite and pick the dealer." },
  { icon: Trophy, tone: "bg-emerald-400/15 text-emerald-200", title: "Stats & leaderboard", text: "Every Normal Win, Koth and Grand Slam is recorded in your history." },
  { icon: Wifi, tone: "bg-indigo-400/15 text-indigo-200", title: "Drop-proof", text: "Lost signal? Your seat and cards wait for you. Reconnect and play on." },
  { icon: ShieldCheck, tone: "bg-teal-400/15 text-teal-200", title: "Fair play", text: "Hands are private, decks are shuffled with secure randomness, no peeking." },
];

const STEPS = [
  { n: 1, icon: Layers, title: "Deal and choose trump", text: "Cards are dealt five, four and four. The player to the dealer's right picks any suit as trump after seeing their first five cards." },
  { n: 2, icon: Swords, title: "Follow suit, win tricks", text: "Follow the suit led when you can. The highest trump wins, otherwise the highest card of the suit led." },
  { n: 3, icon: Crown, title: "Capture the tens", text: "The four tens decide most rounds: capture them with your partner for a Normal Win or Koth, or sweep every trick for 13 Mann." },
];

const WINS = [
  { title: "Normal Win", pts: "1 pt", Icon: Sparkles, text: "Three tens, or two tens and seven tricks once the opponents hold a ten.",
    tone: "border-emerald-300/35 from-emerald-400/[0.14]", medal: "from-emerald-200 via-emerald-400 to-emerald-800", pill: "border-emerald-300/40 text-emerald-200" },
  { title: "Koth", pts: "2 pts", Icon: Crown, text: "Declare after your third ten — the fourth decides everything.",
    tone: "border-amber-300/45 from-amber-400/[0.16]", medal: "from-amber-100 via-amber-300 to-amber-700", pill: "border-amber-300/50 text-amber-200" },
  { title: "Grand Slam · 13 Mann", pts: "3 pts", Icon: Flame, text: "Sweep the first seven tricks, then win all thirteen.",
    tone: "border-rose-300/40 from-rose-400/[0.14]", medal: "from-rose-200 via-rose-400 to-rose-800", pill: "border-rose-300/45 text-rose-200" },
];

const HERO_CARDS = ["10H", "10S", "10D", "10C"];
// The four tens fall into the four trick positions on the mini table: bottom, right, top, left. Positions
// and card width are shares of the table (5:4), so the tens sit inside the felt, apart, at every size.
const TRICK_POS = [{ left: 50, top: 68.75, r: -4 }, { left: 69, top: 50, r: 8 }, { left: 50, top: 31.25, r: 3 }, { left: 31, top: 50, r: -9 }];
const SEATS = [
  { cls: "bottom-[-14px] left-1/2 -translate-x-1/2", team: "sky", label: "You" },
  { cls: "right-[-14px] top-1/2 -translate-y-1/2", team: "amber", label: "Rival" },
  { cls: "top-[-14px] left-1/2 -translate-x-1/2", team: "sky", label: "Partner" },
  { cls: "left-[-14px] top-1/2 -translate-y-1/2", team: "amber", label: "Rival" },
];

function MiniTable() {
  return (
    <div className="relative mx-auto aspect-[5/4] w-full max-w-[400px] [container-type:inline-size]" aria-hidden="true">
      <div className="absolute inset-[9%] rounded-[42%] bg-gradient-to-br from-[#7a4a22] via-[#4a2a12] to-[#2a170a] p-2.5 shadow-[0_40px_80px_-30px_rgba(0,0,0,.95),0_0_0_1px_rgba(251,191,36,.25),inset_0_2px_0_rgba(255,255,255,.12)]">
        <div className="felt grain relative h-full w-full rounded-[42%] border-2 border-amber-500/30 shadow-[inset_0_12px_40px_rgba(0,0,0,.55)]">
          <div className="absolute inset-[14%] rounded-[42%] border border-amber-300/10" />
        </div>
      </div>
      {SEATS.map((s, i) => (
        <div key={i} className={`absolute ${s.cls} flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wider shadow-[0_8px_18px_-8px_rgba(0,0,0,.9)] backdrop-blur ${s.team === "sky"
          ? "border-sky-300/40 bg-[#0c1a2e]/90 text-sky-200" : "border-amber-300/40 bg-[#21160a]/90 text-amber-200"}`}>
          <span className={`h-4 w-4 rounded-full bg-gradient-to-br ${s.team === "sky" ? "from-sky-300 to-sky-600" : "from-amber-300 to-amber-600"}`} />
          {s.label}
        </div>
      ))}
      {HERO_CARDS.map((c, i) => (
        <div key={c} className="absolute aspect-[64/92] w-[16%] -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${TRICK_POS[i].left}%`, top: `${TRICK_POS[i].top}%`, fontSize: "clamp(9px, 3.3cqw, 16px)" }}>
          <motion.div className="h-full w-full"
            initial={{ opacity: 0, y: -120, rotate: -20, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, rotate: TRICK_POS[i].r, scale: 1 }}
            transition={{ delay: 0.35 + i * 0.16, type: "spring", stiffness: 110, damping: 15 }}
            whileHover={{ y: -8, scale: 1.05 }}>
            <PlayingCard card={c} size="fluid" testId={`hero-card-${i}`} className="shadow-[0_16px_30px_-12px_rgba(0,0,0,.9)]" />
          </motion.div>
        </div>
      ))}
      <motion.div className="absolute right-[6%] top-[4%] rounded-full border border-amber-100/70 bg-gradient-to-r from-amber-200 to-amber-400 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-slate-950 shadow-[0_10px_20px_-8px_rgba(0,0,0,.9)]"
        initial={{ opacity: 0, y: 8, scale: 0.8 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: 1.2, type: "spring", stiffness: 200, damping: 14 }}>
        +1 ten
      </motion.div>
    </div>
  );
}

function SectionHead({ eyebrow, title, children }) {
  return (
    <div className="max-w-2xl">
      <p className="eyebrow !text-amber-200/70">{eyebrow}</p>
      <h2 className="mt-2 font-display text-3xl text-amber-50 sm:text-4xl">{title}</h2>
      {children && <p className="mt-3 text-sm leading-relaxed text-white/60 sm:text-base">{children}</p>}
    </div>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-[#070d0a] text-white" data-testid="landing-page">
      <header className="fixed inset-x-0 top-0 z-30 border-b border-white/5 bg-[#06110c]/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-5">
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-amber-100/70 bg-gradient-to-br from-amber-100 via-amber-300 to-amber-600 font-mono text-xs font-black text-slate-950 shadow-[inset_0_2px_0_rgba(255,255,255,.5),0_0_18px_rgba(251,191,36,.35)]" aria-hidden="true">10</span>
            <span className="truncate font-display text-lg font-bold text-amber-200 sm:text-xl">Dehla Pakad</span>
          </span>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <ThemeToggle className="text-white border-white/20" />
            <Link to="/sign-in" className="hidden text-sm font-semibold text-white/80 hover:text-white min-[380px]:inline" data-testid="landing-login-link">Log in</Link>
            <Link to="/sign-up" className="btn-gold !px-4 !py-2 text-sm" data-testid="landing-register-btn">Register</Link>
          </div>
        </div>
      </header>

      <section className="felt grain relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_55%_at_20%_10%,rgba(251,191,36,.16),transparent_60%),radial-gradient(ellipse_60%_60%_at_90%_80%,rgba(0,0,0,.45),transparent_70%)]" aria-hidden="true" />
        <div className="relative mx-auto grid min-h-[92vh] w-full max-w-6xl items-center gap-10 px-5 pb-16 pt-24 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
          <div className="relative z-10">
            <p className="eyebrow inline-flex items-center gap-2 rounded-full border border-amber-300/30 bg-black/25 px-3 py-1 !text-amber-200/90 rise">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-300" /> The Indian game of tens
            </p>
            <h1 className="mt-5 font-display text-4xl leading-[1.05] text-white rise sm:text-5xl lg:text-6xl" style={{ animationDelay: ".08s" }}>
              Capture the tens.<br />
              <span className="bg-gradient-to-r from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-transparent">Claim the table.</span>
            </h1>
            <p className="mt-6 max-w-lg text-base text-emerald-50/75 rise md:text-lg" style={{ animationDelay: ".16s" }}>
              Dehla Pakad online — a premium four-player trick-taking table with partners, trump, Koth and the legendary 13 Mann.
            </p>
            <div className="mt-8 flex flex-wrap gap-3 rise" style={{ animationDelay: ".24s" }}>
              <Link to="/sign-up" className="btn-gold px-7 py-3 text-base shadow-[0_12px_30px_-10px_rgba(251,191,36,.6)]" data-testid="hero-get-started-btn">Create free account</Link>
              <Link to="/sign-in" className="btn-ghost !border-white/15 !bg-white/5 px-6 py-3 text-white" data-testid="hero-login-btn">I have an account</Link>
            </div>
            <ul className="mt-8 flex flex-wrap gap-2 text-xs text-white/70 rise" style={{ animationDelay: ".32s" }}>
              {[[Users, "4 players · 2 teams"], [Swords, "Public matchmaking"], [Layers, "Private rooms"], [Bot, "Practise with bots"]].map(([Icon, text]) => (
                <li key={text} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/25 px-3 py-1.5">
                  <Icon size={13} className="text-amber-200/80" aria-hidden="true" />{text}
                </li>
              ))}
            </ul>
          </div>
          <MiniTable />
        </div>
      </section>

      <section className="relative border-t border-white/5 bg-gradient-to-b from-[#0a1912] to-[#070d0a]">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <SectionHead eyebrow="How a round works" title="Thirteen tricks. Four tens. One table.">
            Two partnerships sit opposite each other. Every round is decided by who captures the tens.
          </SectionHead>
          <ol className="mt-10 grid gap-4 md:grid-cols-3">
            {STEPS.map(({ n, icon: Icon, title, text }) => (
              <li key={n} className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.01] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,.05)]">
                <span className="pointer-events-none absolute -right-2 -top-4 font-display text-7xl text-white/[0.04]" aria-hidden="true">{n}</span>
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-200 to-amber-500 font-mono text-sm font-black text-slate-950">{n}</span>
                  <Icon size={18} className="text-amber-200/80" aria-hidden="true" />
                </div>
                <h3 className="mt-4 font-display text-lg text-amber-50">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/60">{text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-20">
        <SectionHead eyebrow="Why play here" title="Built for the way families and friends actually play." />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="group rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.01] p-5 transition-colors hover:border-amber-300/30">
              <span className={`flex h-11 w-11 items-center justify-center rounded-2xl ${f.tone} transition-transform group-hover:-translate-y-0.5`}><f.icon size={20} aria-hidden="true" /></span>
              <h3 className="mt-4 text-lg font-bold text-white">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-white/60">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-white/5 bg-gradient-to-b from-[#0a1912] to-[#070d0a]">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <SectionHead eyebrow="Ways to win a round" title="Every ten counts." />
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {WINS.map(({ title, pts, Icon, text, tone, medal, pill }) => (
              <div key={title} className={`relative overflow-hidden rounded-3xl border bg-gradient-to-br to-transparent p-5 ${tone}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className={`flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br ring-4 ring-white/10 shadow-[inset_0_2px_0_rgba(255,255,255,.45),0_8px_20px_-8px_rgba(0,0,0,.9)] ${medal}`}>
                    <Icon size={22} className="text-slate-950" aria-hidden="true" />
                  </span>
                  <span className={`rounded-full border bg-black/25 px-3 py-1 font-mono text-sm font-bold ${pill}`}>{pts}</span>
                </div>
                <div className="mt-4 font-display text-xl text-white">{title}</div>
                <p className="mt-1.5 text-sm leading-relaxed text-white/65">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-5 py-20">
        <div className="felt relative mx-auto max-w-4xl overflow-hidden rounded-3xl border border-amber-300/30 px-6 py-12 text-center shadow-[0_30px_70px_-30px_rgba(0,0,0,.95)]">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(251,191,36,.2),transparent_60%)]" aria-hidden="true" />
          <h2 className="relative font-display text-3xl text-amber-50 sm:text-4xl">Your seat is waiting.</h2>
          <p className="relative mx-auto mt-3 max-w-md text-sm text-emerald-50/70 sm:text-base">Create a free account, find a match or invite your partner, and start capturing tens.</p>
          <div className="relative mt-7 flex flex-wrap justify-center gap-3">
            <Link to="/sign-up" className="btn-gold px-7 py-3 text-base" data-testid="cta-get-started-btn">Create free account</Link>
            <Link to="/sign-in" className="btn-ghost !border-white/15 !bg-white/5 px-6 py-3 text-white" data-testid="cta-login-btn">Log in</Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/5 py-8 text-center text-xs text-white/40">© Dehla Pakad · Registration required to play</footer>
    </div>
  );
}
