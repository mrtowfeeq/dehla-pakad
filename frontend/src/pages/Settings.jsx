import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import { useClerk } from "@clerk/react";
import { Check, LogOut, Moon, Palette, Save, Settings2, ShieldCheck, Sun, UserRound, Volume2 } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { AvatarPicker } from "@/components/AvatarPicker";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { SoundSettings } from "@/components/SoundSettings";

const FIELD = "mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none transition-colors placeholder:text-white/30 focus:border-amber-300/60 focus:ring-2 focus:ring-amber-300/25";

function Panel({ icon: Icon, eyebrow, title, tone = "bg-amber-300/15 text-amber-200", children, testid, className = "" }) {
  return (
    <section className={`rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.01] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,.05)] sm:p-6 ${className}`} data-testid={testid}>
      <div className="mb-5 flex items-center gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`} aria-hidden="true"><Icon size={18} /></span>
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/45">{eyebrow}</p>
          <h2 className="font-display text-xl text-amber-50">{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

export default function Settings() {
  const { api, me, refreshMe } = useApp();
  const { resolvedTheme, setTheme } = useTheme();
  const { openUserProfile, signOut } = useClerk();
  const [username, setUsername] = useState(me.username);
  const [displayName, setDisplayName] = useState(me.display_name || "");
  const [bio, setBio] = useState(me.bio || "");
  const [color, setColor] = useState(me.avatar_color);
  const [icon, setIcon] = useState(me.avatar_icon);
  const [busy, setBusy] = useState(false);

  const dirty = username !== me.username || displayName !== (me.display_name || "") || bio !== (me.bio || "")
    || color !== me.avatar_color || icon !== me.avatar_icon;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { await api.patch("/me", { username, display_name: displayName, bio, avatar_color: color, avatar_icon: icon }); await refreshMe(); toast.success("Profile saved"); }
    catch (err) { toast.error(errMsg(err)); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-testid="settings-page">
      <section className="relative overflow-hidden rounded-3xl border border-amber-300/25 bg-gradient-to-br from-[#1b2a4a] via-[#111a30] to-[#0a1120] p-5 shadow-[0_24px_60px_-30px_rgba(0,0,0,.95)] sm:p-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_85%_0%,rgba(251,191,36,.16),transparent_55%)]" aria-hidden="true" />
        <div className="relative flex flex-wrap items-center gap-4">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-200 to-amber-500 text-slate-950 shadow-[inset_0_2px_0_rgba(255,255,255,.4),0_10px_22px_-10px_rgba(0,0,0,.9)]" aria-hidden="true"><Settings2 size={26} /></span>
          <div className="min-w-0 flex-1">
            <p className="eyebrow !text-amber-200/70">Preferences</p>
            <h1 className="break-words font-display text-3xl text-amber-50 sm:text-4xl">Settings</h1>
            <p className="mt-1 text-xs text-white/55">Your player card, table look and sound, and account.</p>
          </div>
          <Link to={`/profile/${me.username}`} className="btn-ghost basis-full justify-center !px-4 !py-2 text-sm sm:basis-auto" data-testid="settings-view-profile">View profile</Link>
        </div>
      </section>

      <form onSubmit={save} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]" data-testid="settings-profile-form">
        <Panel icon={UserRound} eyebrow="Player card" title="Profile">
          <div className="space-y-5">
            <div>
              <label htmlFor="settings-username" className="text-sm font-semibold text-white/85">Username</label>
              <div className="relative">
                <span className="pointer-events-none absolute left-4 top-1/2 mt-1 -translate-y-1/2 text-white/40">@</span>
                <input id="settings-username" data-testid="settings-username-input" value={username} maxLength={20} onChange={(e) => setUsername(e.target.value)}
                  className={`${FIELD} pl-8`} />
              </div>
              <p className="mt-1 text-xs text-white/45">Your unique player name and public profile link.</p>
            </div>
            <div>
              <label htmlFor="profile-display-name" className="text-sm font-semibold text-white/85">Display name</label>
              <input id="profile-display-name" data-testid="settings-display-name-input" value={displayName} maxLength={40}
                onChange={(e) => setDisplayName(e.target.value)} placeholder={username} className={FIELD} />
            </div>
            <div>
              <label htmlFor="profile-bio" className="text-sm font-semibold text-white/85">Short bio</label>
              <textarea id="profile-bio" data-testid="settings-bio-input" value={bio} maxLength={240} rows={3}
                onChange={(e) => setBio(e.target.value)} placeholder="A little about how you play…" className={`${FIELD} resize-y`} />
              <div className={`mt-1 text-right text-xs ${bio.length >= 220 ? "text-amber-300" : "text-white/40"}`}>{bio.length}/240</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-white/85"><Palette size={14} className="text-amber-200" aria-hidden="true" /> Avatar</p>
              <AvatarPicker me={me} color={color} icon={icon} onColor={setColor} onIcon={setIcon} username={username} />
            </div>
          </div>
        </Panel>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="felt relative overflow-hidden rounded-3xl border border-amber-300/30 p-5 text-center shadow-[0_20px_50px_-28px_rgba(0,0,0,.95)]" data-testid="settings-preview">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(251,191,36,.18),transparent_60%)]" aria-hidden="true" />
            <p className="relative text-[10px] font-bold uppercase tracking-[0.14em] text-amber-200/70">Live preview</p>
            <div className="relative mx-auto mt-3 w-fit rounded-full bg-gradient-to-br from-amber-200 via-amber-400 to-amber-700 p-1 shadow-[0_12px_28px_-10px_rgba(0,0,0,.9)]">
              <PlayerAvatar user={{ avatar_color: color, avatar_icon: icon, username }} size={76} />
            </div>
            <div className="relative mt-3 break-words font-display text-2xl leading-tight text-amber-50" data-testid="settings-preview-name">{displayName.trim() || username || "Player"}</div>
            <div className="relative text-sm text-emerald-50/60">@{username}</div>
            {bio.trim() && <p className="relative mt-3 whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-left text-xs italic text-white/75">{bio}</p>}
            <button className="btn-gold relative mt-5 w-full justify-center" disabled={busy || !dirty} data-testid="settings-save-btn">
              {busy ? "Saving…" : dirty ? <><Save size={15} aria-hidden="true" /> Save profile</> : <><Check size={15} aria-hidden="true" /> Saved</>}
            </button>
            {dirty && !busy && <p className="relative mt-2 text-[11px] text-amber-200/80" data-testid="settings-unsaved">You have unsaved changes</p>}
          </div>
        </aside>
      </form>

      <div className="grid gap-6 md:grid-cols-2">
        <Panel icon={resolvedTheme === "light" ? Sun : Moon} eyebrow="Look" title="Appearance" tone="bg-indigo-400/15 text-indigo-200">
          <div className="grid grid-cols-2 gap-3" data-testid="theme-options">
            {[["dark", Moon, "Night table"], ["light", Sun, "Day table"]].map(([t, Icon, hint]) => {
              const active = resolvedTheme === t;
              return (
                <button key={t} type="button" onClick={() => setTheme(t)} data-testid={`theme-option-${t}`} aria-pressed={active}
                  className={`relative flex flex-col items-start gap-2 rounded-2xl border p-4 text-left transition-colors ${active ? "border-amber-300/60 bg-amber-300/10 shadow-[0_0_24px_-12px_rgba(251,191,36,.6)]" : "border-white/10 bg-black/20 hover:border-white/25"}`}>
                  <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${t === "dark" ? "bg-slate-900 text-amber-200" : "bg-amber-50 text-amber-600"}`} aria-hidden="true"><Icon size={17} /></span>
                  <span className="font-semibold capitalize text-white">{t}</span>
                  <span className="text-[11px] text-white/45">{hint}</span>
                  {active && <Check size={15} className="absolute right-3 top-3 text-amber-300" aria-label="Selected" />}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel icon={Volume2} eyebrow="Audio" title="Sound" tone="bg-emerald-400/15 text-emerald-200">
          <SoundSettings dark />
        </Panel>
      </div>

      <Panel icon={ShieldCheck} eyebrow="Account" title="Account & security" tone="bg-sky-400/15 text-sky-200" testid="settings-account">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-sm text-white/60">
            <p>Signed in as <span className="break-all font-semibold text-white/85">{me.email}</span></p>
            <p className="mt-1 text-xs text-white/45">Change your email or password in the account manager. Forgotten passwords can be reset from the login page.</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <button type="button" className="btn-ghost" onClick={() => openUserProfile()} data-testid="manage-account-btn">Manage account</button>
            <button type="button" className="inline-flex items-center gap-2 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-2.5 font-semibold text-rose-300 transition-colors hover:bg-rose-500/20"
              onClick={() => signOut({ redirectUrl: "/" })} data-testid="logout-btn"><LogOut size={15} aria-hidden="true" /> Log out</button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
