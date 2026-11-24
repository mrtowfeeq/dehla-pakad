import { useState } from "react";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import { useClerk } from "@clerk/react";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { AvatarPicker } from "@/components/AvatarPicker";
import { SoundSettings } from "@/components/SoundSettings";

export default function Settings() {
  const { api, me, refreshMe } = useApp();
  const { resolvedTheme, setTheme } = useTheme();
  const { openUserProfile, signOut } = useClerk();
  const [username, setUsername] = useState(me.username);
  const [color, setColor] = useState(me.avatar_color);
  const [icon, setIcon] = useState(me.avatar_icon);
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { await api.patch("/me", { username, avatar_color: color, avatar_icon: icon }); await refreshMe(); toast.success("Profile saved"); }
    catch (err) { toast.error(errMsg(err)); } finally { setBusy(false); }
  };

  return (
    <div className="max-w-2xl space-y-12" data-testid="settings-page">
      <div>
        <p className="eyebrow">Preferences</p>
        <h1 className="font-display text-4xl mt-2">Settings</h1>
      </div>
      <form onSubmit={save} className="space-y-6">
        <h2 className="font-bold text-lg">Profile</h2>
        <div>
          <label className="text-sm font-semibold">Username</label>
          <input data-testid="settings-username-input" value={username} maxLength={20} onChange={(e) => setUsername(e.target.value)}
            className="mt-2 w-full rounded-xl bg-background border border-input px-4 py-3 outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <AvatarPicker me={me} color={color} icon={icon} onColor={setColor} onIcon={setIcon} username={username} />
        <button className="btn-gold" disabled={busy} data-testid="settings-save-btn">{busy ? "Saving…" : "Save profile"}</button>
      </form>
      <section className="space-y-4">
        <h2 className="font-bold text-lg">Appearance</h2>
        <div className="flex gap-2" data-testid="theme-options">
          {["dark", "light"].map((t) => (
            <button key={t} onClick={() => setTheme(t)} data-testid={`theme-option-${t}`}
              className={`px-5 py-2.5 rounded-xl border font-semibold capitalize ${resolvedTheme === t ? "border-primary bg-primary/10" : "border-border"}`}>{t}</button>
          ))}
        </div>
      </section>
      <section className="space-y-4 max-w-md">
        <h2 className="font-bold text-lg">Sound</h2>
        <SoundSettings />
      </section>
      <section className="space-y-3">
        <h2 className="font-bold text-lg">Account & security</h2>
        <p className="text-sm text-muted-foreground">Signed in as {me.email}. Change your email or password in the account manager. Forgotten passwords can be reset from the login page.</p>
        <div className="flex gap-3">
          <button className="btn-ghost" onClick={() => openUserProfile()} data-testid="manage-account-btn">Manage account</button>
          <button className="btn-ghost text-destructive" onClick={() => signOut({ redirectUrl: "/" })} data-testid="logout-btn">Log out</button>
        </div>
      </section>
    </div>
  );
}
